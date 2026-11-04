import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import type { DashboardData } from "~/lib/contracts";
import { env } from "~/env";
import { isLinked } from "~/server/ml";
import { getSyncService, rebuildAll, type RebuildResult, type DashboardStatus } from "~/server/sync";

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
  /** Dev tool: recompute every stored month (history included) with the current formulas. */
  rebuild: linkedProcedure
    .input(z.object({ refetch: z.boolean().default(false) }).default({}))
    .mutation(({ ctx, input }): Promise<RebuildResult> => rebuildAll(ctx.userId, input)),
  status: linkedProcedure.query(
    ({ ctx }): Promise<DashboardStatus> => getSyncService(ctx.userId).status(),
  ),
});
