import type { Prisma } from "../../../generated/prisma";
import { db } from "~/server/db";
import { applySales, type CollectedSale } from "~/server/market/stats";
import type { MarketState } from "~/lib/market";

const key = (itemId: string) => `sold:${itemId}`;

const isSale = (v: unknown): v is CollectedSale =>
  !!v && typeof v === "object" && typeof (v as CollectedSale).sold === "number";

export async function loadSales(ownerId: string, itemIds: string[]): Promise<Map<string, CollectedSale>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db.apiCache.findMany({ where: { ownerId, key: { in: itemIds.map(key) } } });
  return new Map(rows.flatMap((r) => (isSale(r.value) ? [[r.key.slice(5), r.value] as const] : [])));
}

export async function saveSales(ownerId: string, entries: ({ itemId: string } & CollectedSale)[]): Promise<void> {
  await db.$transaction(
    entries.map((e) => {
      const value = { sold: e.sold, nickname: e.nickname } as Prisma.InputJsonValue;
      return db.apiCache.upsert({
        where: { ownerId_key: { ownerId, key: key(e.itemId) } },
        create: { ownerId, key: key(e.itemId), value },
        update: { value },
      });
    }),
  );
}

/** Adds collected sales to whatever research the state carries. */
export async function withSales(ownerId: string, state: MarketState): Promise<MarketState> {
  if (state.status === "none" || !state.data) return state;
  const data = state.data;
  const ids = [...data.points, ...data.excluded.map((e) => e.point)].filter((p) => !p.isOurs).map((p) => p.itemId);
  return { ...state, data: applySales(data, await loadSales(ownerId, ids)) } as MarketState;
}
