import { applyOrder } from "~/server/stock/sales";
import { accountByExternalUser } from "~/server/store/stockSales";
import { markProcessed, recordEvent } from "~/server/store/webhookEvents";

/** Hooks so tests can swap the heavy part; production uses the defaults. (Not in route.ts: Next.js forbids extra route exports.) */
export const handlers = { applyOrder, accountByExternalUser, recordEvent, markProcessed };
