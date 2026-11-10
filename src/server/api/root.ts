import { dashboardRouter } from "~/server/api/routers/dashboard";
import { marketRouter } from "~/server/api/routers/market";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  dashboard: dashboardRouter,
  market: marketRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
