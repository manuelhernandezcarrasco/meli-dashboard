import type { MarketPoint, MarketResearch } from "~/lib/market";
import { itemPermalink } from "~/lib/market";
import { db } from "~/server/db";
import { ensureAccount } from "./bulk";
import type { Marketplace } from "./marketplace";
import { readSellerNicknames } from "./sellers";

/** Scans older than this are pruned when a newer one is saved (the newest is always kept). */
export const SCAN_RETENTION_DAYS = 90;

/** The most recent scan of a catalog product, in the shape the market service works with. */
export async function loadLatestScan(ownerId: string, mp: Marketplace, catalogProductId: string): Promise<MarketResearch | null> {
  const scan = await db.marketScan.findFirst({
    where: { accountId: ownerId, marketplace: mp, catalogProductId },
    orderBy: { fetchedAt: "desc" },
  });
  if (!scan) return null;
  const offers = await db.marketOffer.findMany({ where: { scanId: scan.id }, orderBy: { position: "asc" } });
  const nicks = await readSellerNicknames(mp, [...new Set(offers.map((o) => Number(o.sellerId)))]);
  const toPoint = (o: (typeof offers)[number]): MarketPoint => {
    const sellerId = Number(o.sellerId);
    return {
      itemId: o.itemId,
      sellerId,
      sellerNickname: nicks.get(sellerId) ?? String(sellerId),
      title: o.title ?? scan.catalogTitle,
      price: o.price.toNumber(),
      soldQuantity: o.soldQuantity,
      soldExact: o.soldExact,
      permalink: o.permalink ?? itemPermalink(o.itemId),
      isOurs: o.isOurs,
    };
  };
  return {
    catalogProductId: scan.catalogProductId,
    catalogTitle: scan.catalogTitle,
    points: offers.filter((o) => !o.excluded).map(toPoint),
    excluded: offers.flatMap((o) => (o.excluded ? [{ point: toPoint(o), reason: o.excluded }] : [])),
    regression: scan.regression as unknown as MarketResearch["regression"],
    fetchedAt: scan.fetchedAt.toISOString(),
  };
}

/** Appends a scan (history is kept) and prunes the ones past the retention window. */
export async function saveScan(ownerId: string, mp: Marketplace, r: MarketResearch): Promise<void> {
  await ensureAccount(ownerId);
  const fetchedAt = new Date(r.fetchedAt);
  const offer = (p: MarketPoint, excluded: string | null) => ({
    itemId: p.itemId,
    sellerId: BigInt(p.sellerId),
    title: p.title === r.catalogTitle ? null : p.title,
    price: p.price,
    soldQuantity: p.soldQuantity,
    soldExact: p.soldExact,
    isOurs: p.isOurs,
    permalink: p.permalink === itemPermalink(p.itemId) ? null : p.permalink,
    excluded: excluded as "price_outlier" | "sales_outlier" | "cap" | null,
  });
  const all = [...r.points.map((p) => offer(p, null)), ...r.excluded.map((e) => offer(e.point, e.reason))];
  await db.$transaction(async (tx) => {
    const scan = await tx.marketScan.create({
      data: {
        accountId: ownerId,
        marketplace: mp,
        catalogProductId: r.catalogProductId,
        catalogTitle: r.catalogTitle,
        fetchedAt,
        regression: r.regression as object,
      },
    });
    if (all.length) {
      await tx.marketOffer.createMany({ data: all.map((o, position) => ({ scanId: scan.id, position, ...o })) });
    }
    const cutoff = new Date(fetchedAt.getTime() - SCAN_RETENTION_DAYS * 86_400_000);
    await tx.marketScan.deleteMany({
      where: { accountId: ownerId, marketplace: mp, catalogProductId: r.catalogProductId, fetchedAt: { lt: cutoff }, id: { not: scan.id } },
    });
  });
}
