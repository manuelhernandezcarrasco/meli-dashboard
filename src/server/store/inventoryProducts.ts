import { Prisma } from "../../../generated/prisma";
import type { CostEntryRow, MovementRow, ProductRow } from "~/lib/stock-contracts";
import { db } from "~/server/db";
import { ensureAccount, type Db } from "./bulk";

/** Raised by `createProduct` / `fillProductFields` when the EAN already belongs to another product of the account. */
export class DuplicateEanError extends Error {
  constructor(readonly ean: string) {
    super(`EAN ${ean} ya pertenece a otro producto`);
    this.name = "DuplicateEanError";
  }
}

export interface NewProduct {
  name: string;
  ean?: string | null;
  sku?: string | null;
  model?: string;
  category?: string;
  minUnits?: number | null;
}

export interface ProductIdentity {
  id: number;
  ean: string | null;
  sku: string | null;
  name: string;
  model: string;
  category: string;
  unitCost: number;
  archived: boolean;
}

const identity = (p: {
  id: bigint; ean: string | null; sku: string | null; name: string; model: string; category: string;
  unitCost: Prisma.Decimal; archivedAt: Date | null;
}): ProductIdentity => ({
  id: Number(p.id), ean: p.ean, sku: p.sku, name: p.name, model: p.model, category: p.category,
  unitCost: Number(p.unitCost), archived: p.archivedAt !== null,
});

const isUniqueViolation = (e: unknown): boolean => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** Creates a product with zero stock (stock enters through the ledger). Errors: DuplicateEanError. */
export async function createProduct(accountId: string, p: NewProduct, client: Db = db): Promise<ProductIdentity> {
  await ensureAccount(accountId, client);
  try {
    const row = await client.inventoryProduct.create({
      data: {
        accountId, name: p.name, ean: p.ean ?? null, sku: p.sku ?? null, model: p.model ?? "", category: p.category ?? "",
        minUnits: p.minUnits ?? null,
      },
    });
    return identity(row);
  } catch (e) {
    if (isUniqueViolation(e) && p.ean) throw new DuplicateEanError(p.ean);
    throw e;
  }
}

export async function getProductIdentity(accountId: string, id: number, client: Db = db): Promise<ProductIdentity | null> {
  const row = await client.inventoryProduct.findUnique({ where: { accountId_id: { accountId, id } } });
  return row ? identity(row) : null;
}

export async function getProductIdentities(accountId: string, ids: number[], client: Db = db): Promise<Map<number, ProductIdentity>> {
  const rows = await client.inventoryProduct.findMany({ where: { accountId, id: { in: ids } } });
  return new Map(rows.map((r) => [Number(r.id), identity(r)]));
}

/** Non-archived products that have an EAN: `ean → id`. */
export async function eanIndex(accountId: string, client: Db = db): Promise<Map<string, number>> {
  const rows = await client.inventoryProduct.findMany({
    where: { accountId, ean: { not: null }, archivedAt: null }, select: { id: true, ean: true },
  });
  return new Map(rows.map((r) => [r.ean!, Number(r.id)]));
}

export async function findProductIdByEan(accountId: string, ean: string, client: Db = db): Promise<number | null> {
  const row = await client.inventoryProduct.findUnique({ where: { accountId_ean: { accountId, ean } }, select: { id: true } });
  return row ? Number(row.id) : null;
}

/** Only name / category / minUnits can be edited by hand (identity comes from fills and invoices). */
export async function updateProduct(
  accountId: string, id: number, patch: { name?: string; category?: string; minUnits?: number | null },
): Promise<boolean> {
  const r = await db.inventoryProduct.updateMany({ where: { accountId, id }, data: patch });
  return r.count > 0;
}

export interface ProductFills { ean?: string; sku?: string; name?: string; model?: string; category?: string }

/** Writes the given identity fields. Callers pass only fields that were empty (enrich, never overwrite). */
export async function fillProductFields(accountId: string, id: number, fills: ProductFills, client: Db = db): Promise<void> {
  if (Object.keys(fills).length === 0) return;
  try {
    await client.inventoryProduct.update({ where: { accountId_id: { accountId, id } }, data: fills });
  } catch (e) {
    if (isUniqueViolation(e) && fills.ean) throw new DuplicateEanError(fills.ean);
    throw e;
  }
}

export interface ProductBase extends Omit<ProductRow, "dailyRate" | "coverageDays"> {
  createdAt: Date;
}

const baseRow = (p: Awaited<ReturnType<typeof findProducts>>[number]): ProductBase => ({
  id: Number(p.id), ean: p.ean, sku: p.sku, name: p.name, model: p.model, category: p.category,
  onHand: Number(p.onHand), inRepair: Number(p.inRepair), unitCost: Number(p.unitCost),
  minUnits: p.minUnits === null ? null : Number(p.minUnits), syncMode: p.syncMode,
  linkedListings: p._count.components,
  openAlerts: p.alerts.length,
  archived: p.archivedAt !== null, createdAt: p.createdAt,
});

const findProducts = (where: Prisma.InventoryProductWhereInput) =>
  db.inventoryProduct.findMany({
    where,
    include: { _count: { select: { components: true } }, alerts: { where: { status: { not: "resolved" } }, select: { id: true } } },
    orderBy: { id: "asc" },
  });

export async function listProductBases(
  accountId: string, f: { query?: string; category?: string; includeArchived?: boolean },
): Promise<ProductBase[]> {
  const q = f.query?.trim();
  const where: Prisma.InventoryProductWhereInput = {
    accountId,
    ...(f.includeArchived ? {} : { archivedAt: null }),
    ...(f.category ? { category: f.category } : {}),
    ...(q
      ? { OR: [
          { name: { contains: q, mode: "insensitive" } },
          { ean: { contains: q } },
          { sku: { contains: q, mode: "insensitive" } },
          { model: { contains: q, mode: "insensitive" } },
        ] }
      : {}),
  };
  return (await findProducts(where)).map(baseRow);
}

export async function getProductBase(accountId: string, id: number): Promise<ProductBase | null> {
  const [p] = await findProducts({ accountId, id });
  return p ? baseRow(p) : null;
}

/** Read-only view of the ledger for the product drawer (S1 owns the writes). */
export async function recentMovements(accountId: string, productId: number, limit = 50): Promise<MovementRow[]> {
  const rows = await db.stockMovement.findMany({
    where: { accountId, productId }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: limit,
  });
  return rows.map((m) => ({
    id: Number(m.id), productId: Number(m.productId), type: m.type, quantity: Number(m.quantity),
    occurredAt: m.occurredAt.toISOString(), recordedAt: m.recordedAt.toISOString(),
    onHandAfter: Number(m.onHandAfter), unitCostAfter: Number(m.unitCostAfter),
    refType: m.refType, refId: m.refId, reason: m.reason, actor: m.actor as MovementRow["actor"],
  }));
}

export async function costHistory(accountId: string, productId: number, limit = 100): Promise<CostEntryRow[]> {
  const rows = await db.productCostEntry.findMany({ where: { accountId, productId }, orderBy: { effectiveFrom: "desc" }, take: limit });
  return rows.map((c) => ({
    id: Number(c.id), effectiveFrom: c.effectiveFrom.toISOString(), unitCost: Number(c.unitCost),
    onHandAtChange: Number(c.onHandAtChange), reason: c.reason, refType: c.refType, refId: c.refId, note: c.note,
  }));
}
