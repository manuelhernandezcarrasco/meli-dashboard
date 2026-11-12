import { Prisma } from "../../../generated/prisma";
import { db } from "~/server/db";
import { MERCADOLIBRE } from "./marketplace";

/** Reads (and the one settings write) that sales ingestion (S4) needs. Stock itself changes only via the ledger. */

export async function accountByExternalUser(externalUserId: string): Promise<string | null> {
  const c = await db.marketplaceConnection.findFirst({ where: { marketplace: MERCADOLIBRE, externalUserId }, select: { accountId: true } });
  return c?.accountId ?? null;
}

export interface SalesSettings { cutoverAt: Date | null; lastReconcileAt: Date | null }

export async function readSalesSettings(accountId: string): Promise<SalesSettings | null> {
  const s = await db.inventorySettings.findUnique({ where: { accountId } });
  return s ? { cutoverAt: s.cutoverAt, lastReconcileAt: s.lastReconcileAt } : null;
}

export async function setLastReconcileAt(accountId: string, at: Date): Promise<void> {
  await db.inventorySettings.updateMany({ where: { accountId }, data: { lastReconcileAt: at } });
}

/** Accounts with a Mercado Libre connection and a cutover: the ones the reconcile works on. */
export async function reconcilableAccounts(): Promise<{ accountId: string; externalUserId: string }[]> {
  const rows = await db.marketplaceConnection.findMany({
    where: { marketplace: MERCADOLIBRE, account: { inventorySettings: { is: { cutoverAt: { not: null } } } } },
    select: { accountId: true, externalUserId: true },
    orderBy: { accountId: "asc" },
  });
  return rows;
}

export async function sellerIdOf(accountId: string): Promise<string | null> {
  const c = await db.marketplaceConnection.findUnique({ where: { accountId_marketplace: { accountId, marketplace: MERCADOLIBRE } }, select: { externalUserId: true } });
  return c?.externalUserId ?? null;
}

export interface SalesOrderLine { lineNo: number; itemId: string; variationId: number | null; quantity: number }
export interface SalesOrder { orderId: number; status: string; createdAt: Date; shippingId: number | null; lines: SalesOrderLine[] }

export async function readSalesOrder(accountId: string, orderId: number): Promise<SalesOrder | null> {
  const o = await db.order.findUnique({
    where: { accountId_marketplace_orderId: { accountId, marketplace: MERCADOLIBRE, orderId: BigInt(orderId) } },
    include: { items: { orderBy: { lineNo: "asc" } } },
  });
  if (!o) return null;
  return {
    orderId, status: o.status, createdAt: o.createdAt, shippingId: o.shippingId === null ? null : Number(o.shippingId),
    lines: o.items.map((i) => ({ lineNo: i.lineNo, itemId: i.itemId, variationId: i.variationId === null ? null : Number(i.variationId), quantity: i.quantity })),
  };
}

export const saleRef = (orderId: number, lineNo: number) => `${orderId}:${lineNo}`;

export interface SaleMovementRow { lineNo: number; productId: number; quantity: Prisma.Decimal }

/** The `sale` movements written for an order (one per line and component). */
export async function readSaleMovements(accountId: string, orderId: number): Promise<SaleMovementRow[]> {
  const rows = await db.stockMovement.findMany({
    where: { accountId, type: "sale", refType: "order", refId: { startsWith: `${orderId}:` } },
    orderBy: [{ refId: "asc" }, { productId: "asc" }],
  });
  return rows.map((r) => ({ lineNo: Number(r.refId!.split(":")[1]), productId: Number(r.productId), quantity: r.quantity }));
}

export interface PendingLine { orderId: number; lineNo: number; itemId: string; variationId: number | null; quantity: number; createdAt: Date }

/**
 * Paid order lines created since the cutover that have no `sale` movement, oldest first. "Pending" is this
 * query, not a table. Filtered to one listing when `itemId` is given (and to one variation when `variationId` is).
 */
export async function readPendingLines(
  accountId: string, cutoverAt: Date, filter: { itemId?: string; variationId?: number | null } = {},
): Promise<PendingLine[]> {
  const item = filter.itemId ? Prisma.sql`AND i."itemId" = ${filter.itemId.toUpperCase()}` : Prisma.empty;
  const variation = filter.variationId !== undefined && filter.variationId !== null
    ? Prisma.sql`AND i."variationId" = ${filter.variationId}` : Prisma.empty;
  const rows = await db.$queryRaw<{ orderId: bigint; lineNo: number; itemId: string; variationId: bigint | null; quantity: number; createdAt: Date }[]>`
    SELECT i."orderId", i."lineNo", i."itemId", i."variationId", i."quantity", o."createdAt"
    FROM "OrderItem" i
    JOIN "Order" o ON o."accountId" = i."accountId" AND o."marketplace" = i."marketplace" AND o."orderId" = i."orderId"
    WHERE i."accountId" = ${accountId} AND i."marketplace" = 'mercadolibre'::"Marketplace"
      AND o."status" = 'paid' AND o."createdAt" >= ${cutoverAt}
      ${item} ${variation}
      AND NOT EXISTS (
        SELECT 1 FROM "StockMovement" m
        WHERE m."accountId" = i."accountId" AND m."type" = 'sale' AND m."refType" = 'order'
          AND m."refId" = i."orderId"::text || ':' || i."lineNo"::text)
    ORDER BY o."createdAt", i."orderId", i."lineNo"`;
  return rows.map((r) => ({ orderId: Number(r.orderId), lineNo: r.lineNo, itemId: r.itemId, variationId: r.variationId === null ? null : Number(r.variationId), quantity: r.quantity, createdAt: r.createdAt }));
}

/** Runs `fn` while holding a per-account advisory lock, so webhook and reconcile never interleave. */
export async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock-sales:" + accountId}))`;
    return fn();
  }, { timeout: 10 * 60_000, maxWait: 60_000 });
}
