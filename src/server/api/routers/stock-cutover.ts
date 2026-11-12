import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { CutoverError, runCutover, type CutoverReport } from "~/server/stock/cutover";
import { getCutoverAt, readSnapshotProducts } from "~/server/store/stockCutover";

/** Stock - cutover (S6): the one-time import of the P&L workbook into the ledger. */
export const stockCutoverRouter = createTRPCRouter({
  /** Whether the cutover ran, and how many products a run would import. */
  status: protectedProcedure.query(async ({ ctx }): Promise<{ cutoverAt: string | null; snapshotProducts: number }> => {
    const [at, products] = await Promise.all([getCutoverAt(ctx.userId), readSnapshotProducts(ctx.userId)]);
    return { cutoverAt: at?.toISOString() ?? null, snapshotProducts: products.length };
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
