import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createMarketSearchRouter } from "~/server/api/routers/market-search";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { getMarketService, type MarketState } from "~/server/market/service";
import { isLinked } from "~/server/ml";
import { MlMarketClient } from "~/server/ml/market";

const linkedProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!(await isLinked(ctx.userId))) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ML_NOT_CONNECTED" });
  }
  return next();
});

const input = z.object({ catalogProductId: z.string().min(1) });

const searchRouter = createMarketSearchRouter((ownerId, itemId) =>
  new MlMarketClient(ownerId).getCatalogProductId(itemId),
);

export const marketRouter = createTRPCRouter({
  ...searchRouter._def.procedures,
  /** Stored state only; never triggers ML calls. */
  get: linkedProcedure
    .input(input)
    .query(({ ctx, input }): Promise<MarketState> => getMarketService(ctx.userId).get(input.catalogProductId)),
  /** The only trigger: starts a background refresh if missing/stale and none is running. */
  touch: linkedProcedure
    .input(input)
    .mutation(({ ctx, input }): Promise<MarketState> => getMarketService(ctx.userId).touch(input.catalogProductId)),
});
