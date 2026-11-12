/**
 * Database side of the invoice service (S9). The only code that writes `PurchaseInvoice` / `PurchaseInvoiceLine`.
 *
 * `applyDraft` is the one place that writes several ledger movements in a single transaction: the ledger's own
 * `writeMovement` (S1) opens its own transaction, so it cannot take part in an all-or-nothing apply. It reuses
 * S1's pure `computeMovementEffect`, so the math is the same; keep the row writes in step with stockLedger.ts.
 */
import { Prisma } from "../../../generated/prisma";

import type { InvoiceStatus, LineResolution, ParsedInvoice } from "~/lib/stock-contracts";
import { db } from "~/server/db";
import { StockError, type Decimal } from "~/server/stock/contracts";
import { computeMovementEffect } from "~/server/stock/costing";
import { ensureAccount, type Db } from "./bulk";
import { DuplicateEanError } from "./inventoryProducts";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export interface InvoiceLineRecord {
  lineNo: number;
  supplierCode: string;
  ean: string | null;
  description: string;
  quantity: Decimal;
  unitPrice: Decimal;
  discount: Decimal;
  lineSubtotal: Decimal;
  landedUnitCost: Decimal;
  productId: number | null;
  resolution: LineResolution;
}

export interface InvoiceRecord {
  id: number;
  accountId: string;
  supplierName: string;
  supplierTaxId: string;
  number: string;
  issueDate: string;
  currency: string;
  subtotal: Decimal;
  ivaAmount: Decimal;
  perceptionsAmount: Decimal;
  otherTaxesAmount: Decimal;
  total: Decimal;
  feeFactor: Decimal;
  feeFactorOverridden: boolean;
  status: InvoiceStatus;
  appliedAt: Date | null;
  createdAt: Date;
  sourceFileName: string;
  lines: InvoiceLineRecord[];
}

const FEE_PLACES = 8;
const COST_PLACES = 4;

/** Landed unit cost = net unit price (after discount) × fee factor, to the 4 decimals the column keeps. */
export function landedCost(line: { quantity: Decimal; lineSubtotal: Decimal }, feeFactor: Decimal): Decimal {
  return line.lineSubtotal.div(line.quantity).mul(feeFactor).toDecimalPlaces(COST_PLACES);
}

export function defaultFeeFactor(subtotal: Decimal, total: Decimal): Decimal {
  return subtotal.isZero() ? D(1) : total.div(subtotal).toDecimalPlaces(FEE_PLACES);
}

type Row = Prisma.PurchaseInvoiceGetPayload<{ include: { lines: true } }>;

const toRecord = (r: Row): InvoiceRecord => ({
  id: Number(r.id), accountId: r.accountId, supplierName: r.supplierName, supplierTaxId: r.supplierTaxId, number: r.number,
  issueDate: r.issueDate.toISOString().slice(0, 10), currency: r.currency, subtotal: r.subtotal, ivaAmount: r.ivaAmount,
  perceptionsAmount: r.perceptionsAmount, otherTaxesAmount: r.otherTaxesAmount, total: r.total, feeFactor: r.feeFactor,
  feeFactorOverridden: r.feeFactorOverridden, status: r.status, appliedAt: r.appliedAt, createdAt: r.createdAt,
  sourceFileName: r.sourceFileName,
  lines: r.lines
    .slice()
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => ({
      lineNo: l.lineNo, supplierCode: l.supplierCode, ean: l.ean, description: l.description, quantity: l.quantity,
      unitPrice: l.unitPrice, discount: l.discount, lineSubtotal: l.lineSubtotal, landedUnitCost: l.landedUnitCost,
      productId: l.productId === null ? null : Number(l.productId), resolution: l.resolution,
    })),
});

export async function findByNumber(accountId: string, supplierTaxId: string, number: string): Promise<number | null> {
  const r = await db.purchaseInvoice.findUnique({
    where: { accountId_supplierTaxId_number: { accountId, supplierTaxId, number } }, select: { id: true },
  });
  return r ? Number(r.id) : null;
}

export async function getInvoice(accountId: string, id: number, client: Db = db): Promise<InvoiceRecord | null> {
  const r = await client.purchaseInvoice.findUnique({ where: { accountId_id: { accountId, id } }, include: { lines: true } });
  return r ? toRecord(r) : null;
}

export interface InvoiceSummary {
  id: number; supplierName: string; number: string; issueDate: string; total: Decimal; status: InvoiceStatus;
  lineCount: number; unresolvedLines: number;
}

export async function listInvoices(accountId: string): Promise<InvoiceSummary[]> {
  const rows = await db.purchaseInvoice.findMany({
    where: { accountId }, include: { lines: { select: { resolution: true } } }, orderBy: [{ issueDate: "desc" }, { id: "desc" }],
  });
  return rows.map((r) => ({
    id: Number(r.id), supplierName: r.supplierName, number: r.number, issueDate: r.issueDate.toISOString().slice(0, 10),
    total: r.total, status: r.status, lineCount: r.lines.length, unresolvedLines: r.lines.filter((l) => l.resolution === "unresolved").length,
  }));
}

/**
 * Inserts the draft and its lines in one transaction. `resolved` maps lineNo → product id for lines that matched.
 * Errors: INVOICE_DUPLICATE (carries the existing id in the message).
 */
export async function insertDraft(
  accountId: string, parsed: ParsedInvoice, sourceFileName: string, resolved: Map<number, number>,
): Promise<number> {
  const subtotal = D(parsed.subtotal);
  const feeFactor = defaultFeeFactor(subtotal, D(parsed.total));
  try {
    return await db.$transaction(async (tx) => {
      await ensureAccount(accountId, tx);
      const inv = await tx.purchaseInvoice.create({
        data: {
          accountId, supplierName: parsed.supplierName, supplierTaxId: parsed.supplierTaxId, number: parsed.number,
          issueDate: new Date(`${parsed.issueDate}T00:00:00.000Z`), currency: parsed.currency, subtotal,
          ivaAmount: parsed.ivaAmount, perceptionsAmount: parsed.perceptionsAmount, otherTaxesAmount: parsed.otherTaxesAmount,
          total: parsed.total, feeFactor, sourceFileName,
          lines: {
            create: parsed.lines.map((l) => ({
              lineNo: l.lineNo, supplierCode: l.supplierCode, ean: l.ean, description: l.description,
              quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, lineSubtotal: l.lineSubtotal,
              landedUnitCost: landedCost({ quantity: D(l.quantity), lineSubtotal: D(l.lineSubtotal) }, feeFactor),
              productId: resolved.get(l.lineNo) ?? null,
              resolution: resolved.has(l.lineNo) ? ("auto_ean" as const) : ("unresolved" as const),
            })),
          },
        },
      });
      return Number(inv.id);
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await findByNumber(accountId, parsed.supplierTaxId, parsed.number);
      throw new StockError("INVOICE_DUPLICATE", `Factura ${parsed.number} ya cargada${existing ? ` (id ${existing})` : ""}`);
    }
    throw e;
  }
}

async function requireDraft(tx: Db, accountId: string, id: number): Promise<InvoiceRecord> {
  const inv = await getInvoice(accountId, id, tx);
  if (!inv) throw new StockError("INVOICE_NOT_DRAFT", `Factura ${id} no existe`);
  if (inv.status !== "draft") throw new StockError("INVOICE_NOT_DRAFT", `La factura ${id} ya no es un borrador`);
  return inv;
}

/** Sets (or clears, with null) the fee factor and recomputes every line's landed cost. */
export async function setFeeFactor(accountId: string, id: number, factor: Decimal | null): Promise<void> {
  await db.$transaction(async (tx) => {
    const inv = await requireDraft(tx, accountId, id);
    const feeFactor = factor ? factor.toDecimalPlaces(FEE_PLACES) : defaultFeeFactor(inv.subtotal, inv.total);
    await tx.purchaseInvoice.update({
      where: { accountId_id: { accountId, id } }, data: { feeFactor, feeFactorOverridden: factor !== null },
    });
    for (const l of inv.lines) {
      await tx.purchaseInvoiceLine.update({
        where: { accountId_invoiceId_lineNo: { accountId, invoiceId: id, lineNo: l.lineNo } },
        data: { landedUnitCost: landedCost(l, feeFactor) },
      });
    }
  });
}

/** Ties a line to a product. Errors: INVOICE_NOT_DRAFT, PRODUCT_NOT_FOUND (also for a missing line). */
export async function setLineProduct(
  accountId: string, id: number, lineNo: number, productId: number, resolution: Exclude<LineResolution, "unresolved" | "auto_ean">,
  client?: Db,
): Promise<void> {
  const run = async (tx: Db) => {
    await requireDraft(tx, accountId, id);
    const p = await tx.inventoryProduct.findUnique({ where: { accountId_id: { accountId, id: productId } }, select: { archivedAt: true } });
    if (!p) throw new StockError("PRODUCT_NOT_FOUND", `Producto ${productId} no existe`);
    if (p.archivedAt) throw new StockError("PRODUCT_ARCHIVED", `El producto ${productId} está archivado`);
    const r = await tx.purchaseInvoiceLine.updateMany({ where: { accountId, invoiceId: id, lineNo }, data: { productId, resolution } });
    if (r.count === 0) throw new StockError("INVALID_QUANTITY", `La factura no tiene la línea ${lineNo}`);
  };
  if (client) await run(client);
  else await db.$transaction(run);
}

/** Skipping removes the line from the draft (the schema has no "skipped" state). Errors: INVOICE_NOT_DRAFT. */
export async function deleteLine(accountId: string, id: number, lineNo: number): Promise<void> {
  await db.$transaction(async (tx) => {
    await requireDraft(tx, accountId, id);
    const r = await tx.purchaseInvoiceLine.deleteMany({ where: { accountId, invoiceId: id, lineNo } });
    if (r.count === 0) throw new StockError("INVALID_QUANTITY", `La factura no tiene la línea ${lineNo}`);
  });
}

/** Deletes a draft (frees its number for a new upload). Errors: INVOICE_NOT_DRAFT. */
export async function deleteDraft(accountId: string, id: number): Promise<void> {
  await db.$transaction(async (tx) => {
    await requireDraft(tx, accountId, id);
    await tx.purchaseInvoice.delete({ where: { accountId_id: { accountId, id } } });
  });
}

export interface ApplyResult {
  /** False when the invoice was already applied (double click): nothing was written. */
  applied: boolean;
  productIds: number[];
}

/**
 * All-or-nothing apply: locks the invoice, refuses unresolved lines, fills EMPTY product fields from the lines,
 * writes one `purchase_in` movement per line (key `invoice:<id>:<lineNo>`) and flips the status. Any failure rolls
 * back everything.
 */
export async function applyDraft(accountId: string, id: number, now: Date): Promise<ApplyResult> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: InvoiceStatus }[]>`
      SELECT "status" FROM "PurchaseInvoice" WHERE "accountId" = ${accountId} AND "id" = ${id} FOR UPDATE`;
    const status = locked[0]?.status;
    if (!status) throw new StockError("INVOICE_NOT_DRAFT", `Factura ${id} no existe`);
    if (status === "applied") return { applied: false, productIds: [] };
    if (status !== "draft") throw new StockError("INVOICE_NOT_DRAFT", `La factura ${id} no es un borrador`);

    const inv = (await getInvoice(accountId, id, tx))!;
    if (inv.lines.length === 0) throw new StockError("INVALID_QUANTITY", "La factura no tiene líneas para aplicar");
    if (inv.lines.some((l) => l.productId === null)) throw new StockError("INVOICE_UNRESOLVED", "Hay líneas sin producto");

    // Lock products in id order (no deadlock between concurrent applies), then replay the lines in order.
    const ids = [...new Set(inv.lines.map((l) => l.productId!))].sort((a, b) => a - b);
    const state = new Map<number, { onHand: Decimal; inRepair: Decimal; unitCost: Decimal; ean: string | null; sku: string | null; cost: boolean }>();
    for (const pid of ids) {
      const rows = await tx.$queryRaw<{ onHand: Decimal; inRepair: Decimal; unitCost: Decimal; archivedAt: Date | null; ean: string | null; sku: string | null }[]>`
        SELECT "onHand", "inRepair", "unitCost", "archivedAt", "ean", "sku" FROM "InventoryProduct"
        WHERE "accountId" = ${accountId} AND "id" = ${pid} FOR UPDATE`;
      const p = rows[0];
      if (!p) throw new StockError("PRODUCT_NOT_FOUND", `Producto ${pid} no existe`);
      if (p.archivedAt) throw new StockError("PRODUCT_ARCHIVED", `Producto ${pid} está archivado`);
      state.set(pid, { onHand: D(p.onHand), inRepair: D(p.inRepair), unitCost: D(p.unitCost), ean: p.ean, sku: p.sku, cost: false });
    }

    for (const l of inv.lines) {
      const pid = l.productId!;
      const s = state.get(pid)!;
      // Fill only what is empty; never overwrite.
      const fills: { ean?: string; sku?: string } = {};
      if (!s.ean && l.ean) {
        const owner = await tx.inventoryProduct.findUnique({ where: { accountId_ean: { accountId, ean: l.ean } }, select: { id: true } });
        if (!owner) fills.ean = l.ean;
      }
      if (!s.sku && l.supplierCode.trim()) fills.sku = l.supplierCode.trim();
      if (Object.keys(fills).length > 0) {
        try {
          await tx.inventoryProduct.update({ where: { accountId_id: { accountId, id: pid } }, data: fills });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && fills.ean) throw new DuplicateEanError(fills.ean);
          throw e;
        }
        s.ean = fills.ean ?? s.ean;
        s.sku = fills.sku ?? s.sku;
      }

      const key = `invoice:${id}:${l.lineNo}`;
      const dup = await tx.stockMovement.findUnique({ where: { accountId_idempotencyKey: { accountId, idempotencyKey: key } } });
      if (dup) throw new StockError("IDEMPOTENCY_CONFLICT", `Key ${key} already used`);
      const reason = `Factura ${inv.number} ${inv.supplierName}`;
      const fx = computeMovementEffect(
        { onHand: s.onHand, inRepair: s.inRepair, unitCost: s.unitCost },
        { type: "purchase_in", quantity: l.quantity, unitCost: l.landedUnitCost },
      );
      await tx.stockMovement.create({
        data: {
          accountId, productId: pid, type: "purchase_in", quantity: l.quantity, occurredAt: now, onHandAfter: fx.onHandAfter,
          unitCostAfter: fx.unitCostAfter, idempotencyKey: key, refType: "invoice", refId: String(id), reason, actor: "user",
        },
      });
      await tx.inventoryProduct.update({
        where: { accountId_id: { accountId, id: pid } },
        data: { onHand: fx.onHandAfter, inRepair: fx.inRepairAfter, unitCost: fx.unitCostAfter },
      });
      if (fx.costEntry) {
        await tx.productCostEntry.create({
          data: {
            accountId, productId: pid, effectiveFrom: now, unitCost: fx.costEntry.unitCost,
            onHandAtChange: fx.costEntry.onHandAtChange, reason: "invoice", refType: "invoice", refId: String(id), note: reason,
          },
        });
      }
      s.onHand = fx.onHandAfter;
      s.inRepair = fx.inRepairAfter;
      s.unitCost = fx.unitCostAfter;
    }
    await tx.purchaseInvoice.update({ where: { accountId_id: { accountId, id } }, data: { status: "applied", appliedAt: now } });
    return { applied: true, productIds: ids };
  });
}
