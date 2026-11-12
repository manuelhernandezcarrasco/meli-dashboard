import { readCompetitorSales, saveCompetitorSales } from "~/server/store/competitorSales";
import { MERCADOLIBRE } from "~/server/store/marketplace";
import { applySales, type CollectedSale } from "~/server/market/stats";
import type { MarketState } from "~/lib/market";

export async function loadSales(ownerId: string, itemIds: string[]): Promise<Map<string, CollectedSale>> {
  const rows = await readCompetitorSales(ownerId, MERCADOLIBRE, itemIds);
  return new Map([...rows].map(([id, r]) => [id, { sold: r.sold, nickname: r.nickname }]));
}

export async function saveSales(ownerId: string, entries: ({ itemId: string } & CollectedSale)[]): Promise<void> {
  await saveCompetitorSales(ownerId, MERCADOLIBRE, entries.map((e) => ({ itemId: e.itemId, sold: e.sold, nickname: e.nickname ?? null })));
}

/** Adds collected sales to whatever research the state carries. */
export async function withSales(ownerId: string, state: MarketState): Promise<MarketState> {
  if (state.status === "none" || !state.data) return state;
  const data = state.data;
  const ids = [...data.points, ...data.excluded.map((e) => e.point)].filter((p) => !p.isOurs).map((p) => p.itemId);
  return { ...state, data: applySales(data, await loadSales(ownerId, ids)) } as MarketState;
}
