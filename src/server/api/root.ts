import { dashboardRouter } from "~/server/api/routers/dashboard";
import { marketRouter } from "~/server/api/routers/market";
import { stockAlertsRouter } from "~/server/api/routers/stock-alerts";
import { stockCutoverRouter } from "~/server/api/routers/stock-cutover";
import { stockInvoicesRouter } from "~/server/api/routers/stock-invoices";
import { stockProductsRouter } from "~/server/api/routers/stock-products";
import { stockReturnsRouter } from "~/server/api/routers/stock-returns";
import { stockSyncRouter } from "~/server/api/routers/stock-sync";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  dashboard: dashboardRouter,
  market: marketRouter,
  stockProducts: stockProductsRouter,
  stockCutover: stockCutoverRouter,
  stockInvoices: stockInvoicesRouter,
  stockAlerts: stockAlertsRouter,
  stockReturns: stockReturnsRouter,
  stockSync: stockSyncRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
