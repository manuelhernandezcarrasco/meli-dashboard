import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { getMarketService, type MarketState } from "~/server/market/service";
import { isLinked } from "~/server/ml";

const linkedProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!(await isLinked(ctx.userId))) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ML_NOT_CONNECTED" });
  }
  return next();
});

const input = z.object({ catalogProductId: z.string().min(1) });

/**
 * TODO(T11 merge): compose `marketSearchRouter` (searchOwnProducts, catalogIdForItem) with
 * `mergeRouters` / spreading its procedures here.
 */
export const marketRouter = createTRPCRouter({
  /** Stored state only; never triggers ML calls. */
  get: linkedProcedure
    .input(input)
    .query(({ ctx, input }): Promise<MarketState> => getMarketService(ctx.userId).get(input.catalogProductId)),
  /** The only trigger: starts a background refresh if missing/stale and none is running. */
  touch: linkedProcedure
    .input(input)
    .mutation(({ ctx, input }): Promise<MarketState> => getMarketService(ctx.userId).touch(input.catalogProductId)),
});
