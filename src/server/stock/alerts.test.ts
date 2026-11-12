import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_t6";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));

import type { DashboardData } from "~/lib/contracts";
import { db } from "~/server/db";
import { ensureAccount } from "~/server/store/bulk";
import { countAlerts, listAlerts } from "~/server/store/stockAlerts";
import {
  acknowledgeAlert, dataQualityAlerts, evaluateAlerts, raiseAlert, resolutionForm, resolveAlert, resolveAlertById,
  syncDataQualityAlerts,
} from "./alerts";
import { coverage } from "./forecast";

const A = "s7_user_a";
const B = "s7_user_b";
const NOW = new Date("2026-10-11T15:00:00.000Z"); // Argentine 2026-10-11 12:00 → day 11 of October

beforeEach(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await ensureAccount(A);
  await ensureAccount(B);
});
afterAll(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
});

let seq = 0;
async function product(accountId: string, o: { onHand: number; name?: string; minUnits?: number; ean?: string; linked?: boolean }) {
  const p = await db.inventoryProduct.create({
    data: { accountId, name: o.name ?? `Prod ${++seq}`, onHand: o.onHand, minUnits: o.minUnits, ean: o.ean },
  });
  if (o.linked !== false) {
    const link = await db.listingLink.create({ data: { accountId, marketplace: "mercadolibre", itemId: `MLA${p.id}` } });
    await db.listingLinkComponent.create({ data: { accountId, linkId: link.id, productId: p.id, quantity: 1 } });
  }
  return Number(p.id);
}
let mv = 0;
async function sold(accountId: string, productId: number, units: number, at: string) {
  await db.stockMovement.create({
    data: {
      accountId, productId, type: "sale", quantity: -units, occurredAt: new Date(at), onHandAfter: 0, unitCostAfter: 0,
      idempotencyKey: `t:${++mv}`, actor: "system",
    },
  });
}
const keys = async (accountId: string, status: ("open" | "acknowledged" | "resolved")[] = ["open", "acknowledged"]) =>
  (await listAlerts(accountId, { status })).map((a) => a.dedupeKey).sort();

describe("alert lifecycle", () => {
  const base = { type: "push_failed" as const, dedupeKey: "push_failed:MLA1", title: "t1" };

  it("dedupes while not resolved and refreshes the text", async () => {
    const first = await raiseAlert({ accountId: A, ...base, quantity: 3 });
    const again = await raiseAlert({ accountId: A, ...base, title: "t2", detail: "d", quantity: 4 });
    expect(first.created).toBe(true);
    expect(again).toEqual({ alertId: first.alertId, created: false });
    const [row] = await listAlerts(A, { status: ["open"] });
    expect(row).toMatchObject({ title: "t2", detail: "d", quantity: 4 });
  });

  it("keeps an acknowledged alert acknowledged when raised again", async () => {
    const { alertId } = await raiseAlert({ accountId: A, ...base });
    expect(await acknowledgeAlert(A, alertId)).toBe(true);
    await raiseAlert({ accountId: A, ...base, title: "new" });
    const [row] = await listAlerts(A, { status: ["acknowledged", "open"] });
    expect(row).toMatchObject({ status: "acknowledged", title: "new" });
  });

  it("resolves, never reopens, and a later raise is a new row", async () => {
    const { alertId } = await raiseAlert({ accountId: A, ...base });
    await resolveAlert(A, base.dedupeKey, "auto");
    await resolveAlert(A, base.dedupeKey, "auto"); // no-op
    const second = await raiseAlert({ accountId: A, ...base });
    expect(second.created).toBe(true);
    expect(second.alertId).not.toBe(alertId);
    const resolved = await listAlerts(A, { status: ["resolved"] });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ id: alertId, resolution: "auto" });
    expect(await resolveAlertById(A, second.alertId, "hecho a mano")).toBe(true);
    expect(await resolveAlertById(A, second.alertId, "otra vez")).toBe(false);
  });

  it("isolates accounts and counts non-resolved by type", async () => {
    await raiseAlert({ accountId: A, ...base });
    await raiseAlert({ accountId: A, type: "low_stock", dedupeKey: "low_stock:1", title: "x" });
    const ack = await raiseAlert({ accountId: A, type: "low_stock", dedupeKey: "low_stock:2", title: "x" });
    await acknowledgeAlert(A, ack.alertId);
    await raiseAlert({ accountId: A, type: "low_stock", dedupeKey: "low_stock:3", title: "x" });
    await resolveAlert(A, "low_stock:3", "auto");
    await raiseAlert({ accountId: B, ...base });
    expect(await countAlerts(A)).toEqual({ byType: { push_failed: 1, low_stock: 2 }, open: 2, total: 3 });
    expect((await countAlerts(B)).total).toBe(1);
  });
});

describe("evaluateAlerts", () => {
  it("out_of_stock needs onHand <= 0 and an active link", async () => {
    const linked = await product(A, { onHand: 0 });
    await product(A, { onHand: 0, linked: false });
    await evaluateAlerts(A, NOW);
    expect(await keys(A)).toEqual([`out_of_stock:${linked}`]);
  });

  it("negative_stock asks to check the ML migration", async () => {
    const id = await product(A, { onHand: -2 });
    await evaluateAlerts(A, NOW);
    expect(await keys(A)).toEqual([`negative_stock:${id}`, `out_of_stock:${id}`]);
    const [neg] = await listAlerts(A, { status: ["open"], type: ["negative_stock"] });
    expect(neg!.detail).toMatch(/migración desde Mercado Libre/);
  });

  it("low_stock: critical under 7 days, warning under 15, ok above", async () => {
    const crit = await product(A, { onHand: 5 });
    const warn = await product(A, { onHand: 12 });
    const ok = await product(A, { onHand: 400 });
    for (const id of [crit, warn, ok]) await sold(A, id, 11, "2026-10-05T15:00:00Z"); // 1/day over 11 days
    await evaluateAlerts(A, NOW);
    const low = await listAlerts(A, { status: ["open"], type: ["low_stock"] });
    expect(low.map((a) => a.dedupeKey).sort()).toEqual([`low_stock:${crit}`, `low_stock:${warn}`].sort());
    expect(low.find((a) => a.productId === crit)!.title).toMatch(/crítico/i);
    expect(low.find((a) => a.productId === warn)!.title).toMatch(/bajo/i);
  });

  it("low_stock also fires under minUnits, with or without sales", async () => {
    const id = await product(A, { onHand: 3, minUnits: 5 });
    await product(A, { onHand: 3 }); // no minimum, no sales: nothing to project
    await evaluateAlerts(A, NOW);
    expect(await keys(A)).toEqual([`low_stock:${id}`]);
  });

  it("falls back to last month's rate", async () => {
    const id = await product(A, { onHand: 20 });
    await sold(A, id, 60, "2026-09-15T15:00:00Z"); // 2/day in September → 10 days
    await evaluateAlerts(A, NOW);
    expect(await keys(A)).toEqual([`low_stock:${id}`]);
    expect(await coverage(A, id, NOW)).toMatchObject({ rate: 2, rateSource: "mes anterior", coverageDays: 10, reorderUnits: 40 });
  });

  it("auto-resolves when the condition clears, leaves acknowledged ones tracked until then", async () => {
    const id = await product(A, { onHand: 0 });
    await evaluateAlerts(A, NOW);
    const [a] = await listAlerts(A, { status: ["open"] });
    await acknowledgeAlert(A, a!.id);
    await evaluateAlerts(A, NOW); // still true: stays acknowledged
    expect((await listAlerts(A, { status: ["acknowledged"] }))).toHaveLength(1);
    await db.inventoryProduct.update({ where: { accountId_id: { accountId: A, id } }, data: { onHand: 50 } });
    const r = await evaluateAlerts(A, NOW);
    expect(r.resolved).toBe(1);
    expect(await keys(A)).toEqual([]);
    expect((await listAlerts(A, { status: ["resolved"] }))[0]).toMatchObject({ resolution: "auto" });
  });

  it("is idempotent", async () => {
    await product(A, { onHand: -1 });
    await evaluateAlerts(A, NOW);
    const r = await evaluateAlerts(A, NOW);
    expect(r).toEqual({ raised: 0, resolved: 0 });
    expect(await db.stockAlert.count({ where: { accountId: A } })).toBe(2);
  });

  it("margin_drop: once per cost change, only when margin falls by more than 5 points", async () => {
    const id = await product(A, { onHand: 1000, ean: "7790000000001" });
    await db.saleLine.create({
      data: {
        accountId: A, period: "2026-10", lineNo: 0, saleDate: new Date("2026-10-05"), saleTime: "10:00", marketplace: "mercadolibre",
        channel: "marketplace", orderRef: "1", ean: "7790000000001", matchVia: "x", description: "d", category: "c",
        quantity: 2, unitPrice: 100, revenue: 200, saleFee: 0, financingFee: 0, shippingCost: 0, taxAmount: 0,
        marketplaceCost: 0, unitCost: 0, cogs: 0, costSource: "x", taxSource: "x",
      },
    });
    const entry = (cost: number, at: string) =>
      db.productCostEntry.create({ data: { accountId: A, productId: id, effectiveFrom: new Date(at), unitCost: cost, onHandAtChange: 1, reason: "invoice" } });
    await entry(50, "2026-09-01T00:00:00Z");
    await entry(52, "2026-10-08T00:00:00Z"); // 2 points: no alert
    await evaluateAlerts(A, NOW);
    expect(await keys(A)).toEqual([]);
    const big = await entry(60, "2026-10-09T00:00:00Z"); // 52 → 60 on price 100: -8 points
    await evaluateAlerts(A, NOW);
    expect(await keys(A)).toEqual([`margin_drop:${id}:${big.id}`]);
    await resolveAlert(A, `margin_drop:${id}:${big.id}`, "visto");
    await evaluateAlerts(A, NOW);
    expect(await keys(A)).toEqual([]); // resolved stays resolved: same cost change
  });

  it("auto-resolves push_failed and stock_drift once the sync state recovered", async () => {
    const id = await product(A, { onHand: 5 });
    const link = await db.listingLink.findFirstOrThrow({ where: { accountId: A } });
    await db.listingSyncState.create({ data: { accountId: A, linkId: link.id, status: "failed" } });
    await raiseAlert({ accountId: A, type: "push_failed", dedupeKey: `push_failed:${link.itemId}`, title: "p", itemId: link.itemId, productId: id });
    await raiseAlert({ accountId: A, type: "stock_drift", dedupeKey: `stock_drift:${link.itemId}`, title: "d", itemId: link.itemId, productId: id });
    await evaluateAlerts(A, NOW);
    expect(await keys(A)).toEqual([`push_failed:${link.itemId}`]); // drift gone, push still failing
    await db.listingSyncState.update({ where: { accountId_linkId: { accountId: A, linkId: link.id } }, data: { status: "in_sync" } });
    await evaluateAlerts(A, NOW);
    expect(await keys(A)).toEqual([]);
  });
});

describe("data-quality alerts", () => {
  const proposal = { itemId: "MLA1", title: "Cámara", ean: "779", desc: "Cámara Sony", score: 0.8, qty: 2, venta: 100 };
  const dash = (o: Partial<DashboardData>): DashboardData =>
    ({ rows: [], suggestions: [], autoMatches: [], unmatched: [], ...o }) as DashboardData;

  it("derives the four kinds from the dashboard payload", () => {
    const got = dataQualityAlerts(dash({
      suggestions: [proposal],
      autoMatches: [{ ...proposal, itemId: "MLA2" }],
      unmatched: [{ itemId: "MLA3", sku: "", title: "Sin match", qty: 1, venta: 50 }, { itemId: "MLA1", sku: "", title: "dup", qty: 1, venta: 5 }, { itemId: "MLA9", sku: "", title: "linked", qty: 1, venta: 5 }],
      rows: [{ ean: "E1", desc: "Sin costo", cat: "C", qty: 2, sale: 300, assumed: true }] as DashboardData["rows"],
    }), new Set(["MLA9"]));
    expect(got.map((a) => a.dedupeKey).sort()).toEqual([
      "auto_match:MLA2:779", "missing_cost:E1", "suggested_match:MLA1:779", "unmatched_listing:MLA3",
    ]);
  });

  it("syncs from the stored snapshot and auto-resolves what disappeared", async () => {
    const snap = (d: Partial<DashboardData>) =>
      db.snapshot.upsert({
        where: { accountId_month: { accountId: A, month: "2026-10" } },
        create: { accountId: A, month: "2026-10", payload: dash(d) as object, computedAt: new Date() },
        update: { payload: dash(d) as object, computedAt: new Date() },
      });
    await snap({ suggestions: [proposal] });
    expect(await syncDataQualityAlerts(A)).toEqual({ raised: 1, resolved: 0 });
    expect(await syncDataQualityAlerts(A)).toEqual({ raised: 0, resolved: 0 });
    await snap({});
    expect(await syncDataQualityAlerts(A)).toEqual({ raised: 0, resolved: 1 });
    expect(await keys(A)).toEqual([]);
  });

  it("returns form specs only for the alerts that need data", () => {
    expect(resolutionForm({ type: "unmatched_listing", itemId: "MLA3", productId: null, dedupeKey: "k" })?.submit.procedure).toBe("stockProducts.link");
    expect(resolutionForm({ type: "missing_cost", itemId: null, productId: 4, dedupeKey: "k" })?.fields.map((f) => f.name)).toContain("unitCost");
    expect(resolutionForm({ type: "low_stock", itemId: null, productId: 4, dedupeKey: "k" })).toBeNull();
  });
});

describe("performance", () => {
  it("counts in < 20 ms on 5k products with alerts", { timeout: 60_000 }, async () => {
    const products = await db.inventoryProduct.createManyAndReturn({
      data: Array.from({ length: 5000 }, (_, i) => ({ accountId: A, name: `P${i}`, onHand: 0 })),
      select: { id: true },
    });
    await db.stockAlert.createMany({
      data: products.map((p, i) => ({
        accountId: A, type: i % 2 ? ("low_stock" as const) : ("out_of_stock" as const),
        dedupeKey: `perf:${p.id}`, productId: p.id, title: "t",
      })),
    });
    await countAlerts(A); // warm the connection
    const t0 = performance.now();
    const c = await countAlerts(A);
    const ms = performance.now() - t0;
    expect(c.total).toBe(5000);
    expect(ms).toBeLessThan(20);
  });
});
