import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { CutoverError, runCutover, type CutoverReport } from "~/server/stock/cutover";
import { getCutoverAt, productsByEan, readSnapshotProducts } from "~/server/store/stockCutover";

export interface CutoverStatus {
  cutoverAt: string | null;
  snapshotProducts: number;
  /** Snapshot products with no product yet: what a run would create. */
  productsToCreate: number;
  /** Snapshot products whose EAN already has a product: left as they are. */
  productsExisting: number;
}

/** Stock - cutover (S6): the one-time import of the P&L workbook into the ledger. */
export const stockCutoverRouter = createTRPCRouter({
  /** Whether the cutover ran, and what a run would do: products it would create vs. ones whose EAN already exists. */
  status: protectedProcedure.query(async ({ ctx }): Promise<CutoverStatus> => {
    const [at, products, byEan] = await Promise.all([getCutoverAt(ctx.userId), readSnapshotProducts(ctx.userId), productsByEan(ctx.userId)]);
    const existing = products.filter((p) => byEan.has(p.ean)).length;
    return { cutoverAt: at?.toISOString() ?? null, snapshotProducts: products.length, productsToCreate: products.length - existing, productsExisting: existing };
  }),

  /** The explicit button. `cutoverAt` defaults to the date already set, else now; another date once set is refused. */
  run: protectedProcedure
    .input(z.object({ cutoverAt: z.string().datetime().optional() }))
    .mutation(async ({ ctx, input }): Promise<CutoverReport> => {
      try {
        const at = input.cutoverAt ? new Date(input.cutoverAt) : ((await getCutoverAt(ctx.userId)) ?? new Date());
        return await runCutover(ctx.userId, { cutoverAt: at });
      } catch (e) {
        if (e instanceof CutoverError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message, cause: e });
        throw e;
      }
    }),
});
