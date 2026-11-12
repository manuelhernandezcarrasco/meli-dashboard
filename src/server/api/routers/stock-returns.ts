import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { ResolveReturnInputSchema, ReturnOutcomeSchema, type ReturnRow } from "~/lib/stock-contracts";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { StockError } from "~/server/stock/contracts";
import { getReturnsService, ReturnNotFoundError } from "~/server/stock/returns";
import { listReturns } from "~/server/store/stockReturns";

/** Domain errors → tRPC codes the UI can branch on. */
async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ReturnNotFoundError) throw new TRPCError({ code: "NOT_FOUND", message: e.message });
    if (e instanceof StockError) {
      const code = e.code === "RETURN_TRANSITION" ? "CONFLICT" : e.code === "PRODUCT_NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST";
      throw new TRPCError({ code, message: e.code + ": " + e.message });
    }
    throw e;
  }
}

const CreateReturnInputSchema = z.object({
  orderId: z.number().int().positive(),
  lineNo: z.number().int().min(0),
  productId: z.number().int().positive(),
  quantity: z.number().positive(),
  reason: z.string().max(500).optional(),
});

const ResolveInputSchema = ResolveReturnInputSchema.extend({
  /** Required for `restocked`: the person confirms the unit goes back on sale. */
  confirmRestock: z.boolean().optional(),
});

/** Stock - returns. Returns never change stock on their own; `resolve` is a person's decision. */
export const stockReturnsRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ outcome: ReturnOutcomeSchema.optional() }).default({}))
    .query(({ ctx, input }): Promise<ReturnRow[]> => listReturns(ctx.userId, input.outcome)),

  create: protectedProcedure.input(CreateReturnInputSchema).mutation(({ ctx, input }) =>
    mapErrors(async () => {
      const { record, created } = await getReturnsService().openReturn({ accountId: ctx.userId, ...input });
      return { returnId: record.id, created };
    }),
  ),

  resolve: protectedProcedure.input(ResolveInputSchema).mutation(({ ctx, input }) =>
    mapErrors(async () => {
      const rec = await getReturnsService().resolveReturn({
        accountId: ctx.userId, returnId: input.returnId, outcome: input.outcome,
        note: input.note, confirmRestock: input.confirmRestock,
      });
      return { returnId: rec.id, outcome: rec.outcome };
    }),
  ),
});

