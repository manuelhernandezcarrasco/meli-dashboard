import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import type { DashboardData } from "~/lib/contracts";
import { env } from "~/env";
import { isLinked } from "~/server/ml";
import { getSyncService, type DashboardStatus } from "~/server/sync";

export type { DashboardStatus };

export const dashboardRouter = createTRPCRouter({
  /** Whether the dashboard can be shown: always in demo, once Mercado Libre is linked in live. */
  connection: protectedProcedure.query(async ({ ctx }) => ({
    source: env.DATA_SOURCE,
    linked: env.DATA_SOURCE === "demo" || (await isLinked(ctx.userId)),
  })),
  get: protectedProcedure.query(
    ({ ctx }): Promise<DashboardData> => getSyncService(ctx.userId).getDashboard(),
  ),
  refresh: protectedProcedure.mutation(
    ({ ctx }): Promise<DashboardData> => getSyncService(ctx.userId).forceRefresh(),
  ),
  status: protectedProcedure.query(
    ({ ctx }): Promise<DashboardStatus> => getSyncService(ctx.userId).status(),
  ),
});
