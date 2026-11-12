import { Prisma } from "../../../generated/prisma";
import { db } from "~/server/db";
import type { AlertStatus, AlertType } from "~/lib/stock-contracts";
import type { RaiseAlertInput } from "~/server/stock/contracts";
import { ensureAccount } from "./bulk";
import { MERCADOLIBRE } from "./marketplace";

/** An alert as stored (bigint ids as numbers, decimals as numbers: the edge conversion of the stock stores). */
export interface StoredAlert {
  id: number;
  type: AlertType;
  status: AlertStatus;
  productId: number | null;
  productName: string | null;
  marketplace: "mercadolibre" | null;
  itemId: string | null;
  dedupeKey: string;
  title: string;
  detail: string;
  quantity: number | null;
  amount: number | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  resolution: string | null;
}

type Row = Prisma.StockAlertGetPayload<{ include: { product: { select: { name: true } } } }>;

const num = (d: Prisma.Decimal | null): number | null => (d === null ? null : Number(d));

const toStored = (r: Row): StoredAlert => ({
  id: Number(r.id),
  type: r.type,
  status: r.status,
  productId: r.productId === null ? null : Number(r.productId),
  productName: r.product?.name ?? null,
  marketplace: r.marketplace,
  itemId: r.itemId,
  dedupeKey: r.dedupeKey,
  title: r.title,
  detail: r.detail,
  quantity: num(r.quantity),
  amount: num(r.amount),
  createdAt: r.createdAt,
  acknowledgedAt: r.acknowledgedAt,
  resolvedAt: r.resolvedAt,
  resolution: r.resolution,
});

const withProduct = { product: { select: { name: true } } } as const;

/**
 * Creates the alert or refreshes the existing non-resolved one with the same dedupe key. An acknowledged
 * alert stays acknowledged. A resolved alert is never reopened: a new row is created.
 */
export async function upsertAlert(input: RaiseAlertInput): Promise<{ alertId: number; created: boolean }> {
  await ensureAccount(input.accountId);
  const data = {
    title: input.title,
    detail: input.detail ?? "",
    productId: input.productId ?? null,
    marketplace: input.marketplace ?? null,
    itemId: input.itemId ?? null,
    quantity: input.quantity === undefined ? null : new Prisma.Decimal(input.quantity),
    amount: input.amount === undefined ? null : new Prisma.Decimal(input.amount),
  };
  for (let attempt = 0; ; attempt++) {
    const existing = await db.stockAlert.findFirst({
      where: { accountId: input.accountId, dedupeKey: input.dedupeKey, status: { not: "resolved" } },
      select: { id: true },
    });
    if (existing) {
      await db.stockAlert.update({ where: { accountId_id: { accountId: input.accountId, id: existing.id } }, data });
      return { alertId: Number(existing.id), created: false };
    }
    try {
      const row = await db.stockAlert.create({
        data: { accountId: input.accountId, type: input.type, dedupeKey: input.dedupeKey, ...data },
        select: { id: true },
      });
      return { alertId: Number(row.id), created: true };
    } catch (e) {
      // lost a race with the partial unique index: the other writer's row exists now, update it
      const dup = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
      if (!dup || attempt > 2) throw e;
    }
  }
}

/** Resolves the non-resolved alert of a key. Returns whether one was open. */
export async function resolveByKey(accountId: string, dedupeKey: string, resolution: string, now = new Date()): Promise<boolean> {
  const r = await db.stockAlert.updateMany({
    where: { accountId, dedupeKey, status: { not: "resolved" } },
    data: { status: "resolved", resolvedAt: now, resolution },
  });
  return r.count > 0;
}

/** Resolves a set of alerts by id in one statement. */
export async function resolveByIds(accountId: string, ids: number[], resolution: string, now = new Date()): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await db.stockAlert.updateMany({
    where: { accountId, id: { in: ids.map(BigInt) }, status: { not: "resolved" } },
    data: { status: "resolved", resolvedAt: now, resolution },
  });
  return r.count;
}

/** open → acknowledged. Other states are left alone. Returns whether it changed. */
export async function acknowledgeById(accountId: string, id: number, now = new Date()): Promise<boolean> {
  const r = await db.stockAlert.updateMany({
    where: { accountId, id: BigInt(id), status: "open" },
    data: { status: "acknowledged", acknowledgedAt: now },
  });
  return r.count > 0;
}

export async function getAlert(accountId: string, id: number): Promise<StoredAlert | null> {
  const r = await db.stockAlert.findUnique({ where: { accountId_id: { accountId, id: BigInt(id) } }, include: withProduct });
  return r ? toStored(r) : null;
}

export interface AlertFilter {
  status: AlertStatus[];
  type?: AlertType[];
  productId?: number;
}

export async function listAlerts(accountId: string, f: AlertFilter): Promise<StoredAlert[]> {
  const rows = await db.stockAlert.findMany({
    where: {
      accountId,
      status: { in: f.status },
      ...(f.type ? { type: { in: f.type } } : {}),
      ...(f.productId === undefined ? {} : { productId: BigInt(f.productId) }),
    },
    include: withProduct,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows.map(toStored);
}

/** Non-resolved alerts per type (index accountId,status,type); `open` excludes acknowledged ones. */
export async function countAlerts(accountId: string): Promise<{ byType: Partial<Record<AlertType, number>>; open: number; total: number }> {
  const rows = await db.stockAlert.groupBy({
    by: ["type", "status"],
    where: { accountId, status: { in: ["open", "acknowledged"] } },
    _count: { _all: true },
  });
  const byType: Partial<Record<AlertType, number>> = {};
  let open = 0;
  let total = 0;
  for (const r of rows) {
    byType[r.type] = (byType[r.type] ?? 0) + r._count._all;
    total += r._count._all;
    if (r.status === "open") open += r._count._all;
  }
  return { byType, open, total };
}

/** Non-resolved alerts of the given types (the evaluator diffs against them). */
export async function readLiveAlerts(accountId: string, types: AlertType[]): Promise<StoredAlert[]> {
  const rows = await db.stockAlert.findMany({
    where: { accountId, type: { in: types }, status: { not: "resolved" } },
    include: withProduct,
  });
  return rows.map(toStored);
}

/** Whether any alert (even resolved) ever used the key: for alerts that must fire once per event. */
export async function keyEverUsed(accountId: string, dedupeKey: string): Promise<boolean> {
  return (await db.stockAlert.count({ where: { accountId, dedupeKey } })) > 0;
}

/* ---------- evaluator inputs (set-based reads) ---------- */

export interface ProductStockFacts {
  productId: number;
  name: string;
  onHand: number;
  minUnits: number | null;
  /** Links that include the product as a component. */
  linkCount: number;
  /** Net units sold in [curStart, curEnd) and in [prevStart, curStart): sale + sale_cancel movements. */
  soldCur: number;
  soldPrev: number;
}

export interface FactsWindow { prevStart: Date; curStart: Date; curEnd: Date }

/** One pass over active products with their stock, link count and sold units in the two months. */
export async function readStockFacts(accountId: string, w: FactsWindow, productId?: number): Promise<ProductStockFacts[]> {
  const only = productId === undefined ? Prisma.empty : Prisma.sql`AND p.id = ${BigInt(productId)}`;
  const rows = await db.$queryRaw<
    { id: bigint; name: string; onhand: Prisma.Decimal; minunits: Prisma.Decimal | null; links: number; cur: Prisma.Decimal; prev: Prisma.Decimal }[]
  >(Prisma.sql`
    SELECT p.id, p.name, p."onHand" AS onhand, p."minUnits" AS minunits,
      (SELECT count(*)::int FROM "ListingLinkComponent" c WHERE c."accountId" = p."accountId" AND c."productId" = p.id) AS links,
      COALESCE(SUM(-m.quantity) FILTER (WHERE m."occurredAt" >= ${w.curStart} AND m."occurredAt" < ${w.curEnd}), 0) AS cur,
      COALESCE(SUM(-m.quantity) FILTER (WHERE m."occurredAt" >= ${w.prevStart} AND m."occurredAt" < ${w.curStart}), 0) AS prev
    FROM "InventoryProduct" p
    LEFT JOIN "StockMovement" m
      ON m."accountId" = p."accountId" AND m."productId" = p.id
     AND m.type IN ('sale', 'sale_cancel') AND m."occurredAt" >= ${w.prevStart} AND m."occurredAt" < ${w.curEnd}
    WHERE p."accountId" = ${accountId} AND p."archivedAt" IS NULL ${only}
    GROUP BY p."accountId", p.id`);
  return rows.map((r) => ({
    productId: Number(r.id),
    name: r.name,
    onHand: Number(r.onhand),
    minUnits: r.minunits === null ? null : Number(r.minunits),
    linkCount: r.links,
    soldCur: Number(r.cur),
    soldPrev: Number(r.prev),
  }));
}

export interface CostChange {
  productId: number;
  name: string;
  ean: string | null;
  entryId: number;
  previousCost: number;
  newCost: number;
  effectiveFrom: Date;
}

/** Products whose latest cost entry (since `since`) differs from the one before it. */
export async function readRecentCostChanges(accountId: string, since: Date): Promise<CostChange[]> {
  const rows = await db.$queryRaw<
    { pid: bigint; name: string; ean: string | null; eid: bigint; prev: Prisma.Decimal; cost: Prisma.Decimal; at: Date }[]
  >(Prisma.sql`
    SELECT t."productId" AS pid, p.name, p.ean, t.id AS eid, t.prev, t."unitCost" AS cost, t."effectiveFrom" AS at
    FROM (
      SELECT e.*, lag(e."unitCost") OVER w AS prev, row_number() OVER (PARTITION BY e."productId" ORDER BY e."effectiveFrom" DESC, e.id DESC) AS rn
      FROM "ProductCostEntry" e WHERE e."accountId" = ${accountId}
      WINDOW w AS (PARTITION BY e."productId" ORDER BY e."effectiveFrom", e.id)
    ) t
    JOIN "InventoryProduct" p ON p."accountId" = t."accountId" AND p.id = t."productId"
    WHERE t.rn = 1 AND t.prev IS NOT NULL AND t."effectiveFrom" >= ${since} AND t."unitCost" <> t.prev AND p."archivedAt" IS NULL`);
  return rows.map((r) => ({
    productId: Number(r.pid), name: r.name, ean: r.ean, entryId: Number(r.eid),
    previousCost: Number(r.prev), newCost: Number(r.cost), effectiveFrom: r.at,
  }));
}

/** Average unit price per EAN over sale lines since `sinceDay` (inclusive, Argentine calendar day). */
export async function readAvgUnitPrices(accountId: string, eans: string[], sinceDay: string): Promise<Map<string, number>> {
  if (eans.length === 0) return new Map();
  const rows = await db.saleLine.groupBy({
    by: ["ean"],
    where: { accountId, ean: { in: eans }, saleDate: { gte: new Date(`${sinceDay}T00:00:00.000Z`) } },
    _sum: { revenue: true, quantity: true },
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    const q = Number(r._sum.quantity ?? 0);
    if (r.ean && q > 0) out.set(r.ean, Number(r._sum.revenue ?? 0) / q);
  }
  return out;
}

/** Items that currently have a sync problem, per kind (`failed` / `drift`), for auto-resolving push alerts. */
export async function readProblemItems(accountId: string): Promise<{ failed: Set<string>; drift: Set<string> }> {
  const rows = await db.listingSyncState.findMany({
    where: { accountId, status: { in: ["failed", "drift"] } },
    select: { status: true, link: { select: { itemId: true } } },
  });
  const out = { failed: new Set<string>(), drift: new Set<string>() };
  for (const r of rows) (r.status === "failed" ? out.failed : out.drift).add(r.link.itemId);
  return out;
}

/** Item ids that have at least one listing link. */
export async function readLinkedItemIds(accountId: string): Promise<Set<string>> {
  const rows = await db.listingLink.findMany({ where: { accountId, marketplace: MERCADOLIBRE }, select: { itemId: true }, distinct: ["itemId"] });
  return new Set(rows.map((r) => r.itemId));
}

/** Payload of the most recent dashboard snapshot (the source of the four data-quality alerts), unvalidated. */
export async function readLatestSnapshotPayload(accountId: string): Promise<unknown> {
  const row = await db.snapshot.findFirst({ where: { accountId }, orderBy: { computedAt: "desc" }, select: { payload: true } });
  return row?.payload ?? null;
}
