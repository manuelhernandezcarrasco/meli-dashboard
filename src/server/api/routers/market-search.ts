import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { DashboardDataSchema } from "~/lib/contracts";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  cachedCatalogId, collectOwnProducts, searchOwnProducts,
  type CatalogCache, type CatalogIdLookup, type OwnProductHit,
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
        const products = snap ? collectOwnProducts(DashboardDataSchema.parse(snap.payload)) : [];
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
