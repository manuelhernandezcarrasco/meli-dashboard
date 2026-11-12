import { db } from "~/server/db";
import { ensureAccount } from "./bulk";
import type { Marketplace } from "./marketplace";

export interface CompetitorSaleReading {
  itemId: string;
  sold: number;
  nickname: string | null;
}

/** Latest collected reading per listing, for the listings asked about. */
export async function readCompetitorSales(accountId: string, mp: Marketplace, itemIds: string[]): Promise<Map<string, CompetitorSaleReading>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db.competitorSale.findMany({
    where: { accountId, marketplace: mp, itemId: { in: itemIds.map((i) => i.toUpperCase()) } },
  });
  return new Map(rows.map((r) => [r.itemId, { itemId: r.itemId, sold: r.sold, nickname: r.nickname }]));
}

/** Upsert readings; a later reading of the same listing replaces the earlier one. */
export async function saveCompetitorSales(accountId: string, mp: Marketplace, entries: CompetitorSaleReading[]): Promise<void> {
  if (entries.length === 0) return;
  await ensureAccount(accountId);
  const at = new Date();
  await db.$transaction(
    entries.map((e) => {
      const itemId = e.itemId.toUpperCase();
      return db.competitorSale.upsert({
        where: { accountId_marketplace_itemId: { accountId, marketplace: mp, itemId } },
        create: { accountId, marketplace: mp, itemId, sold: e.sold, nickname: e.nickname, collectedAt: at },
        update: { sold: e.sold, nickname: e.nickname, collectedAt: at },
      });
    }),
  );
}
