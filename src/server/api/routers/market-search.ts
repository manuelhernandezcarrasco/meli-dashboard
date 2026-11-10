import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { DashboardDataSchema } from "~/lib/contracts";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  cachedCatalogId, collectOwnProducts, searchOwnProducts,
  type CatalogCache, type CatalogIdLookup, type OwnProduct, type OwnProductHit,
} from "~/server/market/ownProducts";

const apiCacheStore: CatalogCache = {
  async get(ownerId, key) {
    return (await db.apiCache.findUnique({ where: { ownerId_key: { ownerId, key } } }))?.value;
  },
  async set(ownerId, key, value) {
    await db.apiCache.upsert({
      where: { ownerId_key: { ownerId, key } },
      create: { ownerId, key, value: value as object },
      update: { value: value as object },
    });
  },
};

/** Listings the sync saved as `catalog:<itemId>` (title + Excel product + catalog id). */
async function storedProducts(ownerId: string): Promise<OwnProduct[]> {
  const rows = await db.apiCache.findMany({ where: { ownerId, key: { startsWith: "catalog:" } } });
  const out: OwnProduct[] = [];
  for (const r of rows) {
    const v = r.value as { title?: unknown; desc?: unknown } | null;
    if (!v || typeof v.title !== "string") continue;
    out.push({
      itemId: r.key.slice("catalog:".length),
      title: v.title,
      ...(typeof v.desc === "string" && v.desc ? { desc: v.desc } : {}),
    });
  }
  return out;
}

/** Placeholder until T9 merges; T12 passes `getCatalogProductId` here. */
const unavailableLookup: CatalogIdLookup = () =>
  Promise.reject(new TRPCError({ code: "NOT_IMPLEMENTED", message: "Catalog lookup not wired yet" }));

export function createMarketSearchRouter(lookup: CatalogIdLookup = unavailableLookup, cache: CatalogCache = apiCacheStore) {
  return createTRPCRouter({
    searchOwnProducts: protectedProcedure
      .input(z.object({ query: z.string().max(200) }))
      .query(async ({ ctx, input }): Promise<OwnProductHit[]> => {
        const snap = await db.snapshot.findFirst({
          where: { ownerId: ctx.userId },
          orderBy: { computedAt: "desc" },
        });
        // Products saved by the sync (every sold listing, with its Excel name) first, then the
        // snapshot's lists for anything older than the first sync that stored them.
        const stored = await storedProducts(ctx.userId);
        const seen = new Set(stored.map((p) => p.itemId));
        const fromSnap = snap ? collectOwnProducts(DashboardDataSchema.parse(snap.payload)) : [];
        const products = [...stored, ...fromSnap.filter((p) => !seen.has(p.itemId))];
        return searchOwnProducts({ ownerId: ctx.userId, lookup, cache, products }, input.query);
      }),
    catalogIdForItem: protectedProcedure
      .input(z.object({ itemId: z.string().min(1) }))
      .query(async ({ ctx, input }): Promise<{ catalogProductId: string | null }> => ({
        catalogProductId: await cachedCatalogId({ ownerId: ctx.userId, lookup, cache }, input.itemId),
      })),
  });
}

export const marketSearchRouter = createMarketSearchRouter();
