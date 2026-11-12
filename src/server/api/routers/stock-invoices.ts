import { createTRPCRouter } from "~/server/api/trpc";

/**
 * Stock - invoices. Empty on purpose: created by S0 so the wave-1 tickets do not touch shared files.
 * Add procedures with `protectedProcedure` from ~/server/api/trpc and the schemas of ~/lib/stock-contracts.
 * Owner of this file: see docs/tickets/stock/README.md rule 2.
 */
export const stockInvoicesRouter = createTRPCRouter({});
