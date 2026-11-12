import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { GoLiveInputSchema, type GoLivePreview, type PushLogRow, type SyncStatusRow } from "~/lib/stock-contracts";
import { StockError } from "~/server/stock/contracts";
import { compareWithMl, prepareGoLive, pushLog, setSyncMode, syncStatus } from "~/server/stock/push";

const productId = z.number().int().positive();

/** StockError -> tRPC error; the machine code travels in the message for the UI. */
async function run<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof StockError) {
      throw new TRPCError({ code: e.code === "PRODUCT_NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST", message: e.code, cause: e });
    }
    throw e;
  }
}

/**
 * Stock - sync (S3). Nothing here sends to Mercado Libre unless a product was explicitly switched to `live`
 * through `goLive`; every other procedure reads or writes our own tables.
 */
export const stockSyncRouter = createTRPCRouter({
  /** One row per linked listing: desired quantity, what ML had, last push, mode. */
  status: protectedProcedure.query(({ ctx }): Promise<SyncStatusRow[]> => run(() => syncStatus(ctx.userId))),

  /** Push log, newest first. */
  log: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(100) }).default({ limit: 100 }))
    .query(({ ctx, input }): Promise<PushLogRow[]> => run(() => pushLog(ctx.userId, input.limit))),

  /** Our stock vs ML's, for the confirmation step before going live. */
  goLivePreview: protectedProcedure
    .input(z.object({ productId }))
    .query(({ ctx, input }): Promise<GoLivePreview> => run(() => prepareGoLive(ctx.userId, input.productId))),

  /** Confirms the opening stock of each product and switches it live. */
  goLive: protectedProcedure
    .input(z.object({ confirmations: z.array(GoLiveInputSchema).min(1).max(500) }))
    .mutation(({ ctx, input }) =>
      run(() => setSyncMode(ctx.userId, input.confirmations.map((c) => c.productId), "live", input.confirmations))),

  /** Back to dry-run (no confirmation needed). `productIds` omitted = every linked product. */
  setDryRun: protectedProcedure
    .input(z.object({ productIds: z.array(productId).min(1).optional() }))
    .mutation(({ ctx, input }) => run(() => setSyncMode(ctx.userId, input.productIds ?? "all", "dry_run"))),

  /** Reads ML for every linked listing and flags drift ("Verificar con Mercado Libre"). */
  compare: protectedProcedure.mutation(({ ctx }) => run(() => compareWithMl(ctx.userId))),
});
