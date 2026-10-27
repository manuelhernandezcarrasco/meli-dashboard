import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import type { DashboardData } from "~/lib/contracts";
import { getSyncService, type DashboardStatus } from "~/server/sync";

export type { DashboardStatus };

export const dashboardRouter = createTRPCRouter({
  get: publicProcedure.query((): Promise<DashboardData> => getSyncService().getDashboard()),
  refresh: publicProcedure.mutation((): Promise<DashboardData> => getSyncService().forceRefresh()),
  status: publicProcedure.query((): Promise<DashboardStatus> => getSyncService().status()),
});
