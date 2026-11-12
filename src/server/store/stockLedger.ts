/**
 * Database side of the stock ledger (S1). The only code that writes `StockMovement`, `ProductCostEntry`
 * and the `onHand` / `inRepair` / `unitCost` caches of `InventoryProduct`.
 */
import { Prisma } from "../../../generated/prisma";

import type { Actor, CostReason, MovementType } from "~/lib/stock-contracts";
import { db } from "~/server/db";
import { computeMovementEffect } from "~/server/stock/costing";
import { StockError, type Decimal } from "~/server/stock/contracts";

/** Normalized, validated movement (see `appendMovement` in ledger.ts). */
export interface MovementWrite {
  accountId: string;
  productId: number;
  type: MovementType;
  quantity: Decimal;
  occurredAt: Date;
  unitCost?: Decimal;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
  reason?: string;
  actor: Actor;
}

export interface StoredMovement {
  id: number;
  productId: number;
  type: MovementType;
  quantity: Decimal;
  occurredAt: Date;
  recordedAt: Date;
  onHandAfter: Decimal;
  unitCostAfter: Decimal;
  idempotencyKey: string;
  refType: string | null;
  refId: string | null;
  reason: string | null;
  actor: string;
}

export interface ProductBalance {
  onHand: Decimal;
  inRepair: Decimal;
  unitCost: Decimal;
}

const toStored = (r: Prisma.StockMovementGetPayload<object>): StoredMovement => ({ ...r, id: Number(r.id), productId: Number(r.productId) });

/** Appends one movement atomically: locks the product, inserts the row, updates the caches and cost history. */
export async function writeMovement(m: MovementWrite): Promise<{ movement: StoredMovement; created: boolean }> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ onHand: Decimal; inRepair: Decimal; unitCost: Decimal; archivedAt: Date | null }[]>`
      SELECT "onHand", "inRepair", "unitCost", "archivedAt" FROM "InventoryProduct"
      WHERE "accountId" = ${m.accountId} AND "id" = ${m.productId} FOR UPDATE`;
    const product = locked[0];
    if (!product) throw new StockError("PRODUCT_NOT_FOUND", `Product ${m.productId} not found`);

    // Under the product lock, so concurrent replays of the same key serialize here.
    const existing = await tx.stockMovement.findUnique({
      where: { accountId_idempotencyKey: { accountId: m.accountId, idempotencyKey: m.idempotencyKey } },
    });
    if (existing) {
      if (Number(existing.productId) !== m.productId || existing.type !== m.type || !existing.quantity.eq(m.quantity)) {
        throw new StockError("IDEMPOTENCY_CONFLICT", `Key ${m.idempotencyKey} was used for a different movement`);
      }
      return { movement: toStored(existing), created: false };
    }
    if (product.archivedAt) throw new StockError("PRODUCT_ARCHIVED", `Product ${m.productId} is archived`);

    const state = { onHand: new Prisma.Decimal(product.onHand), inRepair: new Prisma.Decimal(product.inRepair), unitCost: new Prisma.Decimal(product.unitCost) };
    const fx = computeMovementEffect(state, m);
    if (fx.inRepairAfter.isNegative()) throw new StockError("INVALID_QUANTITY", "Not enough units in repair");

    const row = await tx.stockMovement.create({
      data: {
        accountId: m.accountId, productId: m.productId, type: m.type, quantity: m.quantity, occurredAt: m.occurredAt,
        onHandAfter: fx.onHandAfter, unitCostAfter: fx.unitCostAfter, idempotencyKey: m.idempotencyKey,
        refType: m.refType, refId: m.refId, reason: m.reason, actor: m.actor,
      },
    });
    await tx.inventoryProduct.update({
      where: { accountId_id: { accountId: m.accountId, id: m.productId } },
      data: { onHand: fx.onHandAfter, inRepair: fx.inRepairAfter, unitCost: fx.unitCostAfter },
    });
    if (fx.costEntry) {
      await tx.productCostEntry.create({
        data: {
          accountId: m.accountId, productId: m.productId, effectiveFrom: m.occurredAt,
          unitCost: fx.costEntry.unitCost, onHandAtChange: fx.costEntry.onHandAtChange,
          reason: fx.costEntry.reason satisfies CostReason, refType: m.refType, refId: m.refId, note: m.reason,
        },
      });
    }
    return { movement: toStored(row), created: true };
  });
}

/**
 * Cost-only change under the product lock: updates the `unitCost` cache and writes a `manual` cost entry.
 * Stock is not touched. Returns `changed: false` (and writes nothing) when the cost is already that value.
 */
export async function writeManualCost(a: {
  accountId: string; productId: number; unitCost: Decimal; occurredAt: Date; note?: string;
}): Promise<{ changed: boolean; unitCost: Decimal; onHand: Decimal }> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ onHand: Decimal; unitCost: Decimal; archivedAt: Date | null }[]>`
      SELECT "onHand", "unitCost", "archivedAt" FROM "InventoryProduct"
      WHERE "accountId" = ${a.accountId} AND "id" = ${a.productId} FOR UPDATE`;
    const product = locked[0];
    if (!product) throw new StockError("PRODUCT_NOT_FOUND", `Product ${a.productId} not found`);
    if (product.archivedAt) throw new StockError("PRODUCT_ARCHIVED", `Product ${a.productId} is archived`);
    const onHand = new Prisma.Decimal(product.onHand);
    const hasEntry = (await tx.productCostEntry.count({ where: { accountId: a.accountId, productId: a.productId } })) > 0;
    if (hasEntry && a.unitCost.eq(product.unitCost)) return { changed: false, unitCost: a.unitCost, onHand };
    await tx.inventoryProduct.update({
      where: { accountId_id: { accountId: a.accountId, id: a.productId } }, data: { unitCost: a.unitCost },
    });
    await tx.productCostEntry.create({
      data: {
        accountId: a.accountId, productId: a.productId, effectiveFrom: a.occurredAt, unitCost: a.unitCost,
        onHandAtChange: onHand, reason: "manual" satisfies CostReason, refType: "manual_cost", note: a.note,
      },
    });
    return { changed: true, unitCost: a.unitCost, onHand };
  });
}

/** Latest cost entry with `effectiveFrom <= at`; null when none. Throws PRODUCT_NOT_FOUND for an unknown product. */
export async function readCostAt(accountId: string, productId: number, at: Date): Promise<Decimal | null> {
  const product = await db.inventoryProduct.findUnique({ where: { accountId_id: { accountId, id: productId } }, select: { id: true } });
  if (!product) throw new StockError("PRODUCT_NOT_FOUND", `Product ${productId} not found`);
  const e = await db.productCostEntry.findFirst({
    where: { accountId, productId, effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
  });
  return e?.unitCost ?? null;
}

/** Movements of a product, newest first; `before` pages by `occurredAt` (exclusive). */
export async function readMovements(accountId: string, productId: number, opts: { limit?: number; before?: Date } = {}): Promise<StoredMovement[]> {
  const rows = await db.stockMovement.findMany({
    where: { accountId, productId, ...(opts.before ? { occurredAt: { lt: opts.before } } : {}) },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: opts.limit ?? 50,
  });
  return rows.map(toStored);
}

export async function readBalance(accountId: string, productId: number): Promise<ProductBalance | null> {
  const p = await db.inventoryProduct.findUnique({
    where: { accountId_id: { accountId, id: productId } },
    select: { onHand: true, inRepair: true, unitCost: true },
  });
  return p;
}

/** Sum of the ledger; must equal the `onHand` cache. */
export async function sumMovements(accountId: string, productId: number): Promise<Decimal> {
  const r = await db.stockMovement.aggregate({ where: { accountId, productId }, _sum: { quantity: true } });
  return r._sum.quantity ?? new Prisma.Decimal(0);
}
