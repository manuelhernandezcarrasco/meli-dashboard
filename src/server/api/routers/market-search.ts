import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { DashboardDataSchema } from "~/lib/contracts";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { getCatalogId, searchListings, setCatalogId } from "~/server/store/listings";
import { MERCADOLIBRE } from "~/server/store/marketplace";
import { normalizeText } from "~/lib/normalize";
import {
  cachedCatalogId, collectOwnProducts, searchOwnProducts, MAX_SEARCH_RESULTS,
  type CatalogStore, type CatalogIdLookup, type OwnProduct, type OwnProductHit,
} from "~/server/market/ownProducts";

/** Catalog ids live on the listing (`Listing.catalogProductId`, asked-at in `catalogCheckedAt`). */
const listingCatalogStore: CatalogStore = {
  get: (ownerId, itemId) => getCatalogId(ownerId, MERCADOLIBRE, itemId),
  set: (ownerId, itemId, id) => setCatalogId(ownerId, MERCADOLIBRE, itemId, id),
};

/** Placeholder until T9 merges; T12 passes `getCatalogProductId` here. */
const unavailableLookup: CatalogIdLookup = () =>
  Promise.reject(new TRPCError({ code: "NOT_IMPLEMENTED", message: "Catalog lookup not wired yet" }));

export type RecentScan = { catalogProductId: string; title: string; ean: string | null; lastScanAt: string };

export const RECENT_SCANS_LIMIT = 50;

export function createMarketSearchRouter(lookup: CatalogIdLookup = unavailableLookup, cache: CatalogStore = listingCatalogStore) {
  return createTRPCRouter({
    searchOwnProducts: protectedProcedure
      .input(z.object({ query: z.string().max(200) }))
      .query(async ({ ctx, input }): Promise<OwnProductHit[]> => {
        const q = normalizeText(input.query);
        if (!q) return [];
        // Listings the sync saved (every sold listing, with its Excel name), matched in the database
        // through the trigram index. Only when they do not fill the page, the latest snapshot's
        // lists add listings older than the first sync that stored them.
        const stored = await searchListings(ctx.userId, MERCADOLIBRE, q, MAX_SEARCH_RESULTS);
        let products: OwnProduct[] = stored;
        if (stored.length < MAX_SEARCH_RESULTS) {
          const snap = await db.snapshot.findFirst({
            where: { accountId: ctx.userId },
            orderBy: { computedAt: "desc" },
          });
          const seen = new Set(stored.map((p) => p.itemId));
          const fromSnap = snap ? collectOwnProducts(DashboardDataSchema.parse(snap.payload)) : [];
          products = [...stored, ...fromSnap.filter((p) => !seen.has(p.itemId))];
        }
        return searchOwnProducts({ ownerId: ctx.userId, lookup, cache, products }, input.query);
      }),
    /** Catalog products that already have a MarketScan, most recently scanned first. */
    recent: protectedProcedure.query(async ({ ctx }): Promise<RecentScan[]> => {
      const scans = await db.marketScan.findMany({
        where: { accountId: ctx.userId, marketplace: MERCADOLIBRE },
        orderBy: { fetchedAt: "desc" },
        distinct: ["catalogProductId"],
        take: RECENT_SCANS_LIMIT,
        select: { catalogProductId: true, catalogTitle: true, fetchedAt: true },
      });
      if (scans.length === 0) return [];
      const listings = await db.listing.findMany({
        where: {
          accountId: ctx.userId,
          marketplace: MERCADOLIBRE,
          catalogProductId: { in: scans.map((s) => s.catalogProductId) },
          matchedEan: { not: null },
        },
        select: { catalogProductId: true, matchedEan: true },
      });
      const eanOf = new Map(listings.map((l) => [l.catalogProductId, l.matchedEan]));
      return scans.map((s) => ({
        catalogProductId: s.catalogProductId,
        title: s.catalogTitle,
        ean: eanOf.get(s.catalogProductId) ?? null,
        lastScanAt: s.fetchedAt.toISOString(),
      }));
    }),
    catalogIdForItem: protectedProcedure
      .input(z.object({ itemId: z.string().min(1) }))
      .query(async ({ ctx, input }): Promise<{ catalogProductId: string | null }> => ({
        catalogProductId: await cachedCatalogId({ ownerId: ctx.userId, lookup, cache }, input.itemId),
      })),
  });
}

export const marketSearchRouter = createMarketSearchRouter();
