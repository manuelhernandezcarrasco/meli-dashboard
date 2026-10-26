import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { DashboardDataSchema, type DashboardData } from "~/lib/contracts";
import sample from "~/lib/sample-dashboard.json";

// STUB (T0): returns the demo sample. T6 replaces these with the real sync service.
const data = DashboardDataSchema.parse(sample) satisfies DashboardData;

const StatusSchema = z.object({
  updatedAt: z.string(),
  nextRefreshAt: z.string().nullable(),
  cooldownSeconds: z.number(),
  source: z.enum(["demo", "live"]).optional(),
  syncing: z.boolean().optional(),
  lastError: z.string().optional(),
});
export type DashboardStatus = z.infer<typeof StatusSchema>;

export const dashboardRouter = createTRPCRouter({
  get: publicProcedure.query((): DashboardData => data),
  refresh: publicProcedure.mutation((): DashboardData => data),
  status: publicProcedure.query((): DashboardStatus => ({
    updatedAt: data.updatedAt,
    nextRefreshAt: null,
    cooldownSeconds: 0,
    source: "demo",
  })),
});
