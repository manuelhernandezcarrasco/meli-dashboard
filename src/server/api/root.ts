import { dashboardRouter } from "~/server/api/routers/dashboard";
import { marketSearchRouter } from "~/server/api/routers/market-search";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  dashboard: dashboardRouter,
  // T12 replaces this with the full `market` router (which merges marketSearchRouter).
  market: marketSearchRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
