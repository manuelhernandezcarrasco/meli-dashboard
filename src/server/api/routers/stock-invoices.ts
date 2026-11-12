import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  CreateProductInputSchema, SetFeeFactorInputSchema, type InvoiceListRow,
} from "~/lib/stock-contracts";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { StockError } from "~/server/stock/contracts";
import { DuplicateEanError, getInvoiceService, type DraftReview } from "~/server/stock/invoices";

/** Domain errors → tRPC codes the UI can branch on. */
async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof DuplicateEanError) throw new TRPCError({ code: "CONFLICT", message: e.message });
    if (e instanceof StockError) {
      const code =
        e.code === "PRODUCT_NOT_FOUND" ? "NOT_FOUND"
        : e.code === "INVOICE_NOT_DRAFT" || e.code === "INVOICE_UNRESOLVED" || e.code === "INVOICE_DUPLICATE" ? "CONFLICT"
        : "BAD_REQUEST";
      throw new TRPCError({ code, message: `${e.code}: ${e.message}` });
    }
    throw e;
  }
}

const InvoiceIdSchema = z.object({ invoiceId: z.number().int().positive() });
const LineSchema = InvoiceIdSchema.extend({ lineNo: z.number().int().positive() });

/** Stock - invoices. Nothing reaches the ledger before `confirm`. Upload is the REST route /api/invoices/upload. */
export const stockInvoicesRouter = createTRPCRouter({
  list: protectedProcedure.query(({ ctx }): Promise<InvoiceListRow[]> => getInvoiceService().list(ctx.userId)),

  getDraft: protectedProcedure.input(InvoiceIdSchema).query(({ ctx, input }): Promise<DraftReview> =>
    mapErrors(() => getInvoiceService().getDraft(ctx.userId, input.invoiceId))),

  setFeeFactor: protectedProcedure.input(SetFeeFactorInputSchema).mutation(({ ctx, input }) =>
    mapErrors(() => getInvoiceService().setFeeFactor(ctx.userId, input.invoiceId, input.feeFactor))),

  matchLine: protectedProcedure.input(LineSchema.extend({ productId: z.number().int().positive() })).mutation(({ ctx, input }) =>
    mapErrors(() => getInvoiceService().matchLine(ctx.userId, input.invoiceId, input.lineNo, input.productId))),

  createProductFromLine: protectedProcedure.input(LineSchema.extend({ product: CreateProductInputSchema })).mutation(({ ctx, input }) =>
    mapErrors(() => getInvoiceService().createProductFromLine(ctx.userId, input.invoiceId, input.lineNo, input.product))),

  skipLine: protectedProcedure.input(LineSchema).mutation(({ ctx, input }) =>
    mapErrors(() => getInvoiceService().skipLine(ctx.userId, input.invoiceId, input.lineNo))),

  confirm: protectedProcedure.input(InvoiceIdSchema).mutation(({ ctx, input }) =>
    mapErrors(() => getInvoiceService().confirm(ctx.userId, input.invoiceId))),

  discard: protectedProcedure.input(InvoiceIdSchema).mutation(({ ctx, input }) =>
    mapErrors(() => getInvoiceService().discard(ctx.userId, input.invoiceId))),
});
