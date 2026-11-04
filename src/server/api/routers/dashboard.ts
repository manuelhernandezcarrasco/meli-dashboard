import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import type { DashboardData } from "~/lib/contracts";
import { env } from "~/env";
import { isLinked } from "~/server/ml";
import {
  getSyncService, rebuildStatus, saveDecision, startRebuild,
  type RebuildProgress, type DashboardStatus,
} from "~/server/sync";

export type { DashboardStatus };

/** Dashboards are meaningless without a linked Mercado Libre account, in demo mode too. */
const linkedProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!(await isLinked(ctx.userId))) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ML_NOT_CONNECTED" });
  }
  return next();
});

export const dashboardRouter = createTRPCRouter({
  /** Whether the dashboard can be shown: only once this user has linked Mercado Libre. */
  connection: protectedProcedure.query(async ({ ctx }) => ({
    source: env.DATA_SOURCE,
    linked: await isLinked(ctx.userId),
  })),
  get: linkedProcedure.query(
    ({ ctx }): Promise<DashboardData> => getSyncService(ctx.userId).getDashboard(),
  ),
  refresh: linkedProcedure.mutation(
    ({ ctx }): Promise<DashboardData> => getSyncService(ctx.userId).forceRefresh(),
  ),
  /** Starts recomputing every month (history included) in the background; poll `rebuildStatus`. */
  rebuild: linkedProcedure
    .input(
      z.object({ refetch: z.boolean().default(false), from: z.string().regex(/^\d{4}-\d{2}$/).optional() }).default({}),
    )
    .mutation(({ ctx, input }): RebuildProgress => startRebuild(ctx.userId, input)),
  rebuildStatus: linkedProcedure.query(({ ctx }): RebuildProgress => rebuildStatus(ctx.userId)),
  /** Yes/no on "is this listing that P&L product?"; recomputes the month right away. */
  decideMatch: linkedProcedure
    .input(z.object({
      itemId: z.string().min(1), ean: z.string().min(1), decision: z.enum(["confirmed", "rejected"]),
    }))
    .mutation(async ({ ctx, input }): Promise<DashboardData> => {
      await saveDecision(ctx.userId, input.itemId, input.ean, input.decision);
      return getSyncService(ctx.userId).recompute();
    }),
  status: linkedProcedure.query(
    ({ ctx }): Promise<DashboardStatus> => getSyncService(ctx.userId).status(),
  ),
});
