/**
 * Database side of the cutover (S6): the P&L snapshot to import, the cutover date, the products already
 * seeded, and the frozen-cost history the P&L calculation reads. Stock and cost are written elsewhere,
 * through the S1 ledger only.
 */
import type { LedgerCosts } from "~/server/calc/lines";
import { db } from "~/server/db";
import { ensureAccount } from "./bulk";

export interface SnapshotProduct {
  ean: string;
  description: string;
  model: string;
  category: string;
  unitCost: number;
  stockFinal: number;
}

/** The P&L close the account uploaded (`Product` rows), in workbook order. */
export async function readSnapshotProducts(accountId: string): Promise<SnapshotProduct[]> {
  const rows = await db.product.findMany({ where: { accountId }, orderBy: { position: "asc" } });
  return rows.map((p) => ({
    ean: p.ean, description: p.description, model: p.model, category: p.category,
    unitCost: p.unitCost, stockFinal: p.stockFinal,
  }));
}

export async function getCutoverAt(accountId: string): Promise<Date | null> {
  const s = await db.inventorySettings.findUnique({ where: { accountId }, select: { cutoverAt: true } });
  return s?.cutoverAt ?? null;
}

/** Sets the cutover moment only when none is set. Returns the date that is in effect afterwards. */
export async function setCutoverAtOnce(accountId: string, at: Date): Promise<Date> {
  await ensureAccount(accountId);
  await db.inventorySettings.upsert({ where: { accountId }, create: { accountId, cutoverAt: at }, update: {} });
  // `update: {}` leaves an existing row alone; fill a row that exists without a date
  await db.inventorySettings.updateMany({ where: { accountId, cutoverAt: null }, data: { cutoverAt: at } });
  return (await getCutoverAt(accountId))!;
}

export interface ProductState { id: number; onHand: number; unitCost: number }

/** `ean → product` for every product of the account that has an EAN (archived ones included). */
export async function productsByEan(accountId: string): Promise<Map<string, ProductState>> {
  const rows = await db.inventoryProduct.findMany({
    where: { accountId, ean: { not: null } }, select: { id: true, ean: true, onHand: true, unitCost: true },
  });
  return new Map(rows.map((r) => [r.ean!, { id: Number(r.id), onHand: Number(r.onHand), unitCost: Number(r.unitCost) }]));
}

/**
 * The frozen-cost lookup for the P&L calculation, or undefined before the cutover. Loads the whole cost history
 * once so `buildLines` stays synchronous; the answer for a past instant never changes (entries are append-only).
 */
export async function loadLedgerCosts(accountId: string): Promise<LedgerCosts | undefined> {
  const cutoverAt = await getCutoverAt(accountId);
  if (!cutoverAt) return undefined;
  const [products, entries] = await Promise.all([
    db.inventoryProduct.findMany({
      where: { accountId, ean: { not: null } }, select: { id: true, ean: true, name: true, category: true },
    }),
    db.productCostEntry.findMany({
      where: { accountId }, select: { productId: true, effectiveFrom: true, unitCost: true },
      orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
    }),
  ]);
  const history = new Map<number, { at: number; cost: number }[]>();
  for (const e of entries) {
    const id = Number(e.productId);
    const list = history.get(id) ?? [];
    list.push({ at: e.effectiveFrom.getTime(), cost: Number(e.unitCost) });
    history.set(id, list);
  }
  return {
    cutoverAt,
    products: new Map(products.map((p) => [p.ean!, { id: Number(p.id), name: p.name, category: p.category }])),
    costAt: (productId, at) => {
      const list = history.get(productId);
      if (!list) return null;
      const t = at.getTime();
      let lo = 0;
      let hi = list.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid]!.at <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return found < 0 ? null : list[found]!.cost;
    },
  };
}

export const countLinks = (accountId: string): Promise<number> => db.listingLink.count({ where: { accountId } });
