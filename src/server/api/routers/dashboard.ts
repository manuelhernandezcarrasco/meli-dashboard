import { TRPCError } from "@trpc/server";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import type { DashboardData } from "~/lib/contracts";
import { getTokens } from "~/server/ml/tokens";
import { getSyncService, type DashboardStatus } from "~/server/sync";

export type { DashboardStatus };

/** Dashboards are meaningless without a linked Mercado Libre account. */
const connectedProcedure = publicProcedure.use(async ({ next }) => {
  if (!(await getTokens())) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "ML_NOT_CONNECTED" });
  }
  return next();
});

export const dashboardRouter = createTRPCRouter({
  connection: publicProcedure.query(async (): Promise<{ connected: boolean }> => ({
    connected: (await getTokens()) !== null,
  })),
  get: connectedProcedure.query((): Promise<DashboardData> => getSyncService().getDashboard()),
  refresh: connectedProcedure.mutation((): Promise<DashboardData> => getSyncService().forceRefresh()),
  status: connectedProcedure.query((): Promise<DashboardStatus> => getSyncService().status()),
});
