import { reconcileAll } from "~/server/stock/sales";

/** Hooks so tests can swap the heavy part; production uses the defaults. (Not in route.ts: Next.js forbids extra route exports.) */
export const handlers = { reconcileAll };
