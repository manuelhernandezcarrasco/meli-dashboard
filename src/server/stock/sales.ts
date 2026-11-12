/**
 * S4 — sales ingestion. A paid Mercado Libre order takes stock out through the S1 ledger; a cancellation
 * before shipping puts it back; a cancellation after shipping opens a return case (S8). Driven by the
 * `orders_v2` webhook (fast path) and a scheduled reconcile (safety net); both are idempotent per order line.
 */
import type { Order } from "~/lib/contracts";
import { compactOrder } from "~/server/ml/compact";
import { mlFetch } from "~/server/ml/http";
import { tokenAuthFor } from "~/server/ml/tokens";
import { saveOrders } from "~/server/store/orders";
import { MERCADOLIBRE } from "~/server/store/marketplace";
import { findLink } from "~/server/store/stockLinks";
import {
  readPendingLines, readSalesOrder, readSalesSettings, readSaleMovements, reconcilableAccounts, saleRef,
  sellerIdOf, setLastReconcileAt, withAccountLock, type PendingLine,
} from "~/server/store/stockSales";
import type { Actor } from "~/lib/stock-contracts";
import type { AlertService, LedgerService, PushService } from "./contracts";
import { evaluateAlerts, raiseAlert, resolveAlert } from "./alerts";
import { appendMovement } from "./ledger";
import { compareWithMl, requestPush } from "./push";
import { getReturnsService } from "./returns";

const API = "https://api.mercadolibre.com";
const DAY_MS = 86_400_000;
const SHIPPED = new Set(["shipped", "delivered"]);

/** Everything outside the database: Mercado Libre reads and the sibling stock services. Injected for tests. */
export interface SalesDeps {
  ml: {
    /** One order in the contract shape, or null when ML does not know it. */
    fetchOrder(accountId: string, orderId: number): Promise<Order | null>;
    /** Orders created or updated since `since`. */
    searchOrders(accountId: string, since: Date): Promise<Order[]>;
    /** ML's shipment status (`shipped`, `delivered`, `ready_to_ship`, ...), null when unknown. */
    shipmentStatus(accountId: string, shippingId: number): Promise<string | null>;
  };
  appendMovement: LedgerService["appendMovement"];
  raiseAlert: AlertService["raiseAlert"];
  resolveAlert: AlertService["resolveAlert"];
  requestPush: PushService["requestPush"];
  compareWithMl(accountId: string): Promise<unknown>;
  openReturn(i: { accountId: string; orderId: number; lineNo: number; productId: number; quantity: number; reason?: string }): Promise<unknown>;
  evaluateAlerts(accountId: string): Promise<unknown>;
  now(): Date;
}

/* ---------- real Mercado Libre reads (GET only, through mlFetch) ---------- */

const p2 = (n: number) => String(n).padStart(2, "0");
function fmtArg(d: Date): string {
  const a = new Date(d.getTime() - 3 * 3600_000);
  return `${a.getUTCFullYear()}-${p2(a.getUTCMonth() + 1)}-${p2(a.getUTCDate())}T${p2(a.getUTCHours())}:${p2(a.getUTCMinutes())}:${p2(a.getUTCSeconds())}.000-03:00`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const defaultMl: SalesDeps["ml"] = {
  async fetchOrder(accountId, orderId) {
    const raw = (await mlFetch("GET", `${API}/orders/${orderId}`, { auth: tokenAuthFor(accountId) })) as any;
    return raw ? compactOrder(raw) : null;
  },
  async searchOrders(accountId, since) {
    const seller = await sellerIdOf(accountId);
    if (!seller) return [];
    const out: Order[] = [];
    for (let offset = 0; ; offset += 50) {
      const r = (await mlFetch("GET", `${API}/orders/search`, {
        auth: tokenAuthFor(accountId),
        query: { seller, "order.date_last_updated.from": fmtArg(since), sort: "date_asc", limit: 50, offset },
      })) as any;
      const res: any[] = r?.results ?? [];
      out.push(...res.map(compactOrder));
      if (offset + 50 >= (r?.paging?.total ?? 0) || res.length === 0) break;
    }
    return out;
  },
  async shipmentStatus(accountId, shippingId) {
    const s = (await mlFetch("GET", `${API}/shipments/${shippingId}`, { auth: tokenAuthFor(accountId) })) as any;
    return typeof s?.status === "string" ? s.status : null;
  },
};

const defaultDeps: SalesDeps = {
  ml: defaultMl,
  appendMovement,
  raiseAlert,
  resolveAlert,
  requestPush,
  compareWithMl,
  openReturn: (i) => getReturnsService().openReturn(i),
  evaluateAlerts: (a) => evaluateAlerts(a),
  now: () => new Date(),
};

export type ApplyOutcome =
  | { status: "not_found" | "no_cutover" | "pre_cutover" | "ignored" }
  | { status: "applied"; movements: number; unmatched: number; cancelled: number; returns: number };

export interface ReconcileResult { accountId: string; orders: number; applied: number; errors: number }

export function createSales(over: Partial<SalesDeps> = {}) {
  const d: SalesDeps = { ...defaultDeps, ...over };

  /** Resolve a line to its link: the variation's own link first, then the whole-listing link. */
  async function linkOf(accountId: string, itemId: string, variationId: number | null) {
    return (variationId !== null ? await findLink(accountId, MERCADOLIBRE, itemId, variationId) : null)
      ?? (await findLink(accountId, MERCADOLIBRE, itemId, null));
  }

  /** Writes the sale movements of one line. Returns the products touched, or null when the line is not linked. */
  async function sellLine(
    accountId: string, orderId: number, line: { lineNo: number; itemId: string; variationId: number | null; quantity: number }, at: Date, actor: Actor,
  ): Promise<number[] | null> {
    const link = await linkOf(accountId, line.itemId, line.variationId);
    if (!link) return null;
    const touched: number[] = [];
    for (const c of link.components) {
      await d.appendMovement({
        accountId, productId: c.productId, type: "sale", quantity: -(line.quantity * c.quantity), occurredAt: at,
        idempotencyKey: `sale:${orderId}:${line.lineNo}:${c.productId}`, refType: "order", refId: saleRef(orderId, line.lineNo), actor,
      });
      touched.push(c.productId);
    }
    return touched;
  }

  async function alertUnmatched(accountId: string, itemId: string, orderId: number) {
    await d.raiseAlert({
      accountId, type: "unmatched_sale", dedupeKey: itemId, marketplace: MERCADOLIBRE, itemId,
      title: `Venta sin vincular: ${itemId}`,
      detail: `La orden ${orderId} (y posiblemente otras) vendió «${itemId}», que no está vinculada a un producto. El stock se descontará cuando la vincules.`,
    });
  }

  async function cancelOrder(accountId: string, order: NonNullable<Awaited<ReturnType<typeof readSalesOrder>>>, actor: Actor) {
    const sales = await readSaleMovements(accountId, order.orderId);
    if (sales.length === 0) return { cancelled: 0, returns: 0, products: [] as number[] };
    const status = order.shippingId !== null ? await d.ml.shipmentStatus(accountId, order.shippingId) : null;
    if (status !== null && SHIPPED.has(status)) {
      // already on its way: a person decides what comes back
      let returns = 0;
      const seen = new Set<number>();
      for (const s of sales) {
        if (seen.has(s.lineNo)) continue; // one case per order line
        seen.add(s.lineNo);
        await d.openReturn({ accountId, orderId: order.orderId, lineNo: s.lineNo, productId: s.productId, quantity: s.quantity.abs().toNumber(), reason: "Orden cancelada después del envío" });
        returns++;
      }
      return { cancelled: 0, returns, products: [] as number[] };
    }
    const products: number[] = [];
    for (const s of sales) {
      await d.appendMovement({
        accountId, productId: s.productId, type: "sale_cancel", quantity: s.quantity.abs(), occurredAt: d.now(),
        idempotencyKey: `sale_cancel:${order.orderId}:${s.lineNo}:${s.productId}`, refType: "order", refId: saleRef(order.orderId, s.lineNo),
        reason: "Orden cancelada antes del envío", actor,
      });
      products.push(s.productId);
    }
    return { cancelled: sales.length, returns: 0, products };
  }

  /** Push the new quantities, then re-evaluate the stock alerts. Neither may undo a stock change already written. */
  async function afterStockChange(accountId: string, productIds: number[], ref: string): Promise<void> {
    await d.requestPush(accountId, productIds, { type: "sale", ref });
    await d.evaluateAlerts(accountId).catch((e) => console.error("[stock] alert evaluation after sale failed", e));
  }

  /** Persist + apply an order already read from Mercado Libre. Caller holds the account lock. */
  async function applyFetched(accountId: string, order: Order, actor: Actor): Promise<ApplyOutcome> {
    await saveOrders(accountId, MERCADOLIBRE, [order]);
    const settings = await readSalesSettings(accountId);
    if (!settings?.cutoverAt) return { status: "no_cutover" };
    const stored = await readSalesOrder(accountId, order.id);
    if (!stored) return { status: "not_found" };
    if (stored.createdAt < settings.cutoverAt) return { status: "pre_cutover" };

    if (stored.status === "paid") {
      const touched = new Set<number>();
      let movements = 0;
      let unmatched = 0;
      for (const line of stored.lines) {
        const products = await sellLine(accountId, stored.orderId, line, stored.createdAt, actor);
        if (products === null) { unmatched++; await alertUnmatched(accountId, line.itemId, stored.orderId); continue; }
        movements += products.length;
        products.forEach((p) => touched.add(p));
      }
      if (touched.size) await afterStockChange(accountId, [...touched], String(stored.orderId));
      return { status: "applied", movements, unmatched, cancelled: 0, returns: 0 };
    }
    if (stored.status === "cancelled") {
      const r = await cancelOrder(accountId, stored, actor);
      if (r.products.length) await afterStockChange(accountId, [...new Set(r.products)], String(stored.orderId));
      return { status: "applied", movements: 0, unmatched: 0, cancelled: r.cancelled, returns: r.returns };
    }
    return { status: "ignored" };
  }

  /** Fetch one order from Mercado Libre, store it and change stock accordingly. Safe to repeat. */
  async function applyOrder(accountId: string, orderId: number, actor: Actor = "webhook"): Promise<ApplyOutcome> {
    return withAccountLock(accountId, async () => {
      const order = await d.ml.fetchOrder(accountId, orderId);
      if (!order) return { status: "not_found" };
      return applyFetched(accountId, order, actor);
    });
  }

  /**
   * Apply the parked sales of a listing, oldest first. Called by S5 once the link exists and its cost review
   * alert is resolved. Returns the number of order lines applied.
   */
  async function applyPendingForListing(accountId: string, itemId: string, variationId?: number | null, actor: Actor = "system"): Promise<number> {
    return withAccountLock(accountId, async () => {
      const settings = await readSalesSettings(accountId);
      if (!settings?.cutoverAt) return 0;
      const lines: PendingLine[] = await readPendingLines(accountId, settings.cutoverAt, { itemId, variationId });
      const touched = new Set<number>();
      let applied = 0;
      for (const l of lines) {
        const products = await sellLine(accountId, l.orderId, l, l.createdAt, actor);
        if (products === null) continue;
        applied++;
        products.forEach((p) => touched.add(p));
      }
      if (touched.size) await afterStockChange(accountId, [...touched], `pending:${itemId}`);
      const left = await readPendingLines(accountId, settings.cutoverAt, { itemId });
      const stillUnlinked = (await Promise.all(left.map((l) => linkOf(accountId, l.itemId, l.variationId)))).some((l) => !l);
      if (!stillUnlinked) await d.resolveAlert(accountId, itemId.toUpperCase(), "auto");
      return applied;
    });
  }

  /** Number of parked paid lines of a listing (what S5 shows in the cost review alert). */
  async function pendingSalesCount(accountId: string, itemId: string, variationId: number | null): Promise<number> {
    const settings = await readSalesSettings(accountId);
    if (!settings?.cutoverAt) return 0;
    return (await readPendingLines(accountId, settings.cutoverAt, { itemId, variationId })).length;
  }

  /** Safety net for missed webhooks: re-read recent orders, apply what is missing, compare with ML. */
  async function reconcileAccount(accountId: string): Promise<ReconcileResult> {
    const started = d.now();
    const settings = await readSalesSettings(accountId);
    const res: ReconcileResult = { accountId, orders: 0, applied: 0, errors: 0 };
    if (!settings?.cutoverAt) return res;
    const since = new Date(Math.max(settings.cutoverAt.getTime(), (settings.lastReconcileAt ?? settings.cutoverAt).getTime() - DAY_MS));
    const orders = await d.ml.searchOrders(accountId, since);
    res.orders = orders.length;
    for (const o of [...orders].sort((a, b) => a.dateCreated.localeCompare(b.dateCreated) || a.id - b.id)) {
      try {
        const r = await withAccountLock(accountId, () => applyFetched(accountId, o, "system"));
        if (r.status === "applied" && (r.movements > 0 || r.cancelled > 0 || r.returns > 0)) res.applied++;
      } catch (e) {
        res.errors++;
        console.error(`[stock-reconcile] order ${o.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try { await d.compareWithMl(accountId); } catch (e) { res.errors++; console.error(`[stock-reconcile] compare: ${e instanceof Error ? e.message : String(e)}`); }
    try { await d.evaluateAlerts(accountId); } catch (e) { res.errors++; console.error(`[stock-reconcile] alerts: ${e instanceof Error ? e.message : String(e)}`); }
    if (res.errors === 0) await setLastReconcileAt(accountId, started);
    return res;
  }

  async function reconcileAll(): Promise<ReconcileResult[]> {
    const out: ReconcileResult[] = [];
    for (const a of await reconcilableAccounts()) {
      try { out.push(await reconcileAccount(a.accountId)); }
      catch (e) { out.push({ accountId: a.accountId, orders: 0, applied: 0, errors: 1 }); console.error(`[stock-reconcile] ${a.accountId}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return out;
  }

  return { applyOrder, applyPendingForListing, pendingSalesCount, reconcileAccount, reconcileAll };
}

export type SalesService = ReturnType<typeof createSales>;

let instance: SalesService | undefined;
const get = () => (instance ??= createSales());
export const applyOrder = (accountId: string, orderId: number, actor?: Actor) => get().applyOrder(accountId, orderId, actor);
export const applyPendingForListing = (accountId: string, itemId: string, variationId?: number | null) => get().applyPendingForListing(accountId, itemId, variationId);
export const pendingSalesCount = (accountId: string, itemId: string, variationId: number | null) => get().pendingSalesCount(accountId, itemId, variationId);
export const reconcileAccount = (accountId: string) => get().reconcileAccount(accountId);
export const reconcileAll = () => get().reconcileAll();
