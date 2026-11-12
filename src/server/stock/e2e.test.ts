/**
 * X1 — end-to-end check of the stock loop, server level, on a throwaway database, with Mercado Libre mocked at
 * `fetch` (nothing real is ever contacted).
 *
 * Everything runs through the PRODUCTION wiring: the real tRPC routers, the real webhook / cron / invoice-upload
 * route handlers and the real default dependencies of every service. No `configureStock`, `configureReturnsService`
 * or other test-only injection is used on purpose: a scenario that only works with injected fakes is a product
 * gap, and shows up here as `it.fails` with the reason (see docs/tickets/stock/X1-report.md).
 *
 * Run alone: `pnpm vitest run src/server/stock/e2e.test.ts` (needs TEST_DATABASE_URL, default pnl_x1).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_x1";
  process.env.CRON_SECRET = "x1-cron-secret";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: "x1_acct" }) }));
vi.mock("~/server/ml/tokens", () => ({
  tokenAuthFor: () => ({ getAccessToken: () => Promise.resolve("tok"), refresh: () => Promise.resolve() }),
  isLinked: async () => true,
}));
vi.mock("~/server/ml", async (orig) => ({ ...(await orig<Record<string, unknown>>()), isLinked: async () => true }));
const afters: (() => Promise<void>)[] = [];
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => Promise<void>) => { afters.push(fn); },
}));

import { createCallerFactory } from "~/server/api/trpc";
import { stockAlertsRouter } from "~/server/api/routers/stock-alerts";
import { stockCutoverRouter } from "~/server/api/routers/stock-cutover";
import { stockInvoicesRouter } from "~/server/api/routers/stock-invoices";
import { stockProductsRouter } from "~/server/api/routers/stock-products";
import { stockReturnsRouter } from "~/server/api/routers/stock-returns";
import { stockSyncRouter } from "~/server/api/routers/stock-sync";
import { POST as invoiceUpload } from "~/app/api/invoices/upload/route";
import { GET as cronReconcile } from "~/app/api/cron/stock-reconcile/route";
import { POST as webhook } from "~/app/api/webhooks/ml/route";
import { db } from "~/server/db";
import { ensureAccount } from "~/server/store/bulk";
import { loadLedgerCosts } from "~/server/store/stockCutover";
import { saveUpload } from "~/server/workbooks/store";
import { appendMovement, costAt, recomputeOnHand } from "./ledger";
import { evaluateAlerts } from "./alerts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 }); // tRPC adds a random 100-500 ms dev delay per call

const A = "x1_acct";
const OTHER = "x1_other";
const ML = "mercadolibre" as const;
const ROOT = path.resolve(import.meta.dirname, "../../..");
const PNL = readFileSync(path.join(ROOT, "demo/PnL_MercadoLibre_Septiembre2026_DEMO.xlsx"));
const SONY = readFileSync(path.join(import.meta.dirname, "../invoices/__fixtures__/sony-0225-00085935.pdf"));

/** Demo workbook products used below. */
const XM5 = { ean: "4548736143111", stock: 32, cost: 520000 }; // Sony WH-1000XM5 -> listing MLA1 (auto-linked by GTIN)
const XB100 = { ean: "4548736150461", stock: 32, cost: 72000 }; // Sony SRS-XB100 -> listing MLA2 (auto-linked by GTIN)
const ULT = { ean: "4548736141513", stock: 9, cost: 125000 }; // Sony ULT Field 1 -> listing MLA3 (no GTIN: manual link)

const ctx = (userId: string | null) => ({ db, userId, headers: new Headers() });
const products = (u: string | null = A) => createCallerFactory(stockProductsRouter)(ctx(u));
const alertsApi = (u: string | null = A) => createCallerFactory(stockAlertsRouter)(ctx(u));
const invoicesApi = (u: string | null = A) => createCallerFactory(stockInvoicesRouter)(ctx(u));
const returnsApi = (u: string | null = A) => createCallerFactory(stockReturnsRouter)(ctx(u));
const syncApi = (u: string | null = A) => createCallerFactory(stockSyncRouter)(ctx(u));
const cutoverApi = (u: string | null = A) => createCallerFactory(stockCutoverRouter)(ctx(u));

/* ------------------------------------------------------------------------------------------------ fake ML */

interface FakeItem { qty: number; status: string; logistic?: string; variations?: { id: number; qty: number }[] }
interface RawOrder { id: number; status: string; date_created: string; shipping: { id: number | null }; order_items: unknown[]; payments: unknown[] }
interface Call { method: string; url: string; body: unknown }

let items: Map<string, FakeItem>;
let orders: Map<number, RawOrder>;
let shipments: Map<number, string>;
let calls: Call[];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push({ method, url: url.origin + url.pathname + url.search, body: init?.body ? (JSON.parse(String(init.body)) as unknown) : null });
  if (url.hostname !== "api.mercadolibre.com") return json({ message: "unexpected host" }, 500);
  if (method === "PUT") {
    const m = /^\/items\/(\w+)$/.exec(url.pathname);
    const it = m && items.get(m[1]!);
    if (!it) return json({ message: "not found" }, 404);
    const b = JSON.parse(String(init!.body)) as { available_quantity?: number; variations?: { id: number; available_quantity: number }[] };
    if (b.available_quantity !== undefined) it.qty = b.available_quantity;
    return json({ id: m[1] });
  }
  if (method !== "GET") return json({ message: "blocked in the fake" }, 405);
  if (url.pathname === "/items") {
    return json((url.searchParams.get("ids") ?? "").split(",").filter(Boolean).map((id) => {
      const it = items.get(id);
      return it
        ? { code: 200, body: { id, available_quantity: it.qty, status: it.status, listing_type_id: "gold_special", variations: (it.variations ?? []).map((v) => ({ id: v.id, available_quantity: v.qty })), shipping: { logistic_type: it.logistic ?? "cross_docking" } } }
        : { code: 404, body: {} };
    }));
  }
  let m = /^\/orders\/(\d+)$/.exec(url.pathname);
  if (m) { const o = orders.get(Number(m[1])); return o ? json(o) : json({}, 404); }
  if (url.pathname === "/orders/search") return json({ results: [...orders.values()], paging: { total: orders.size } });
  m = /^\/shipments\/(\d+)$/.exec(url.pathname);
  if (m) { const s = shipments.get(Number(m[1])); return s ? json({ status: s }) : json({}, 404); }
  return json({ message: `unhandled ${url.pathname}` }, 404);
}

const rawOrder = (id: number, itemId: string, qty: number, over: { status?: string; shippingId?: number | null; createdAt?: string; unitPrice?: number } = {}): RawOrder => ({
  id, status: over.status ?? "paid", date_created: over.createdAt ?? new Date().toISOString(), shipping: { id: over.shippingId ?? null },
  order_items: [{ item: { id: itemId, title: `Título ${itemId}`, variation_id: null }, quantity: qty, unit_price: over.unitPrice ?? 900000, sale_fee: 100000 }],
  payments: [{ id: id * 10, status: "approved" }],
});
const putOrder = (o: RawOrder) => orders.set(o.id, o);

/* ------------------------------------------------------------------------------------------------ helpers */

const drain = async () => { while (afters.length) await afters.shift()!(); };
let noteSeq = 0;
/** One `orders_v2` notification, as ML sends it; processed to the end. */
async function notify(orderId: number, eventId = `n-${++noteSeq}`) {
  const res = await webhook(new Request("http://x/api/webhooks/ml", {
    method: "POST", body: JSON.stringify({ _id: eventId, topic: "orders_v2", resource: `/orders/${orderId}`, user_id: 70777001 }),
  }));
  await drain();
  return res;
}

const pid = async (ean: string) => Number((await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_ean: { accountId: A, ean } } })).id);
const onHand = async (id: number) => Number((await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_id: { accountId: A, id: BigInt(id) } } })).onHand);
const inRepair = async (id: number) => Number((await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_id: { accountId: A, id: BigInt(id) } } })).inRepair);
const movs = (productId: number, type?: string) =>
  db.stockMovement.findMany({ where: { accountId: A, productId: BigInt(productId), ...(type ? { type: type as never } : {}) }, orderBy: { id: "asc" } });
const pushRows = (itemId?: string) => db.mlPushLog.findMany({ where: { accountId: A, ...(itemId ? { itemId } : {}) }, orderBy: { id: "asc" } });
const alertsOf = (type: string) => db.stockAlert.findMany({ where: { accountId: A, type: type as never }, orderBy: { id: "asc" } });
const mlWrites = () => calls.filter((c) => c.method !== "GET");

const CUT = new Date(Date.now() - 2 * 86_400_000);

/** Fresh account with the demo P&L uploaded, three ML listings, cutover run through the router. */
async function world(opts: { cutover?: boolean } = {}) {
  await db.account.deleteMany({ where: { id: { in: [A, OTHER] } } });
  await ensureAccount(A);
  await db.marketplaceConnection.create({ data: { accountId: A, marketplace: ML, externalUserId: "70777001", accessToken: "x", refreshToken: "y", expiresAt: new Date(Date.now() + 3600_000) } });
  await saveUpload(A, "pnl", "PnL_Septiembre2026_DEMO.xlsx", PNL);
  await db.listing.createMany({
    data: [
      { accountId: A, marketplace: ML, itemId: "MLA1", title: "Sony WH-1000XM5", gtin: XM5.ean },
      { accountId: A, marketplace: ML, itemId: "MLA2", title: "Sony SRS-XB100", gtin: XB100.ean },
      { accountId: A, marketplace: ML, itemId: "MLA3", title: "Sony ULT Field 1 parlante", gtin: null },
    ],
  });
  items = new Map([
    ["MLA1", { qty: 30, status: "active" }],
    ["MLA2", { qty: 10, status: "active" }],
    ["MLA3", { qty: 5, status: "active" }],
  ]);
  orders = new Map(); shipments = new Map(); calls = []; afters.length = 0;
  if (opts.cutover !== false) await cutoverApi().run({ cutoverAt: CUT.toISOString() });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.account.deleteMany({ where: { id: { in: [A, OTHER] } } });
  await db.$disconnect();
});

/* ================================================================================================ 1 */

describe("1. Cutover from the demo P&L workbook", () => {
  it("creates products, initial movements and costs; exact-GTIN listings auto-link; ledger == cache", async () => {
    await world();
    const snapshot = await db.product.count({ where: { accountId: A } });
    expect(snapshot).toBeGreaterThan(5);
    expect(await db.inventoryProduct.count({ where: { accountId: A } })).toBe(snapshot);

    const xm5 = await pid(XM5.ean);
    const row = await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_id: { accountId: A, id: BigInt(xm5) } } });
    expect(Number(row.onHand)).toBe(XM5.stock);
    expect(Number(row.unitCost)).toBe(XM5.cost);
    expect((await movs(xm5)).map((m) => m.type)).toEqual(["initial_count"]);
    const ce = await db.productCostEntry.findMany({ where: { accountId: A, productId: BigInt(xm5) } });
    expect(ce).toHaveLength(1);
    expect(ce[0]).toMatchObject({ reason: "initial" });
    expect((await db.inventorySettings.findUniqueOrThrow({ where: { accountId: A } })).cutoverAt).toEqual(CUT);

    const links = await db.listingLink.findMany({ where: { accountId: A }, include: { components: true } });
    expect(links.map((l) => l.itemId).sort()).toEqual(["MLA1", "MLA2"]); // MLA3 has no GTIN
    expect(links.every((l) => l.components.length === 1 && Number(l.components[0]!.quantity) === 1)).toBe(true);

    for (const p of await db.inventoryProduct.findMany({ where: { accountId: A } })) {
      expect(Number(await recomputeOnHand(A, Number(p.id)))).toBe(Number(p.onHand));
    }
  });

  it("is idempotent and refuses another date; the unlinked listing shows up as unlinked", async () => {
    await world();
    const again = await cutoverApi().run({ cutoverAt: CUT.toISOString() });
    expect(again).toMatchObject({ alreadyDone: true, productsCreated: 0 });
    await expect(cutoverApi().run({ cutoverAt: new Date().toISOString() })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await products().unlinkedListings()).map((l) => l.itemId)).toEqual(["MLA3"]);
  });

  // KNOWN GAP (X1-G1: linking service default alerts are a dropped stand-in; nothing wires raiseAlert); see X1-report.md. Remove `.fails` when fixed.
  it.fails("raises an unmatched_listing alert for the listing that could not be auto-linked (S5 spec 2)", async () => {
    await world();
    expect((await alertsOf("unmatched_listing")).map((a) => a.itemId)).toEqual(["MLA3"]);
  });
});

/* ================================================================================================ 2 */

describe("2. Sony invoice: upload -> review -> manual match -> confirm", () => {
  const upload = async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(SONY)], "01-0225-00085935.pdf", { type: "application/pdf" }));
    return invoiceUpload(new Request("http://x/api/invoices/upload", { method: "POST", body: form }));
  };

  it("review shows factor ~1,27001 and line-1 landed cost ~69.971,74; unresolved lines block confirm", async () => {
    await world();
    const res = await upload();
    expect(res.status).toBe(200);
    const { invoiceId } = (await res.json()) as { invoiceId: number };
    const d = await invoicesApi().getDraft({ invoiceId });
    expect(d.feeFactor).toBeCloseTo(1.27001, 4);
    expect(d.feeSentence).toContain("27,00 %");
    expect(d.lines).toHaveLength(6);
    expect(d.lines[0]!.landedUnitCost).toBeCloseTo(69971.74, 1);
    expect(d.lines.every((l) => l.resolution === "unresolved")).toBe(true); // the sample EANs are not in the demo workbook
    expect(d.canConfirm).toBe(false);
    await expect(invoicesApi().confirm({ invoiceId })).rejects.toBeTruthy();
    expect(await movs(await pid(XM5.ean), "purchase_in")).toHaveLength(0);
  });

  it("a duplicate upload is rejected with a link to the existing invoice", async () => {
    await world();
    expect((await upload()).status).toBe(200);
    const dup = await upload();
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ existingInvoiceId: expect.any(Number) });
  });

  it("manual match + skip the rest + confirm: ledger, cost history, projected == applied, dry-run push log, no ML write", async () => {
    await world();
    const xm5 = await pid(XM5.ean);
    const { invoiceId } = (await (await upload()).json()) as { invoiceId: number };
    await invoicesApi().matchLine({ invoiceId, lineNo: 1, productId: xm5 });
    for (const lineNo of [2, 3, 4, 5, 6]) await invoicesApi().skipLine({ invoiceId, lineNo });
    const d = await invoicesApi().getDraft({ invoiceId });
    expect(d.canConfirm).toBe(true);
    const l1 = d.lines[0]!;
    expect(l1.productId).toBe(xm5);
    expect(l1.willFill).toEqual({ sku: expect.any(String) }); // only the empty field (SKU) is filled; EAN and name are never overwritten
    expect(l1.projected!.onHand).toBe(XM5.stock + l1.quantity);
    expect(l1.projected!.unitCost).toBeCloseTo((XM5.stock * XM5.cost + l1.quantity * l1.landedUnitCost) / (XM5.stock + l1.quantity), 2);

    await invoicesApi().confirm({ invoiceId });
    await invoicesApi().confirm({ invoiceId }); // double click: still one application

    const row = await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_id: { accountId: A, id: BigInt(xm5) } } });
    expect(Number(row.onHand)).toBe(l1.projected!.onHand);
    expect(Number(row.unitCost)).toBeCloseTo(l1.projected!.unitCost, 2);
    expect(await movs(xm5, "purchase_in")).toHaveLength(1);
    expect(Number(await recomputeOnHand(A, xm5))).toBe(Number(row.onHand));
    const ce = await db.productCostEntry.findMany({ where: { accountId: A, productId: BigInt(xm5) }, orderBy: { id: "asc" } });
    expect(ce).toHaveLength(2);
    expect(ce[1]!.reason).toBe("invoice");
    expect((await db.purchaseInvoice.findFirstOrThrow({ where: { accountId: A } })).status).toBe("applied");

    // a dry-run push log row for the one linked listing affected (MLA1); nothing for the others
    const log = await pushRows();
    expect(log.map((r) => [r.itemId, r.mode, r.result, r.triggerType, r.requestedQty])).toEqual([
      ["MLA1", "dry_run", "dry_run", "invoice", l1.projected!.onHand],
    ]);
    expect(mlWrites()).toEqual([]);
  });
});

/* ================================================================================================ 3 */

describe("3. Webhook sale of a linked listing", () => {
  it("one sale movement with the cost frozen at that time; the same webhook twice (same or new event id) is still one", async () => {
    await world();
    const xm5 = await pid(XM5.ean);
    putOrder(rawOrder(9001, "MLA1", 2));
    const res = await notify(9001, "evt-1");
    expect(res.status).toBe(200);
    await notify(9001, "evt-1"); // exact duplicate -> WebhookEvent unique key
    await notify(9001, "evt-2"); // ML re-sends with a new id -> movement idempotency key
    const sales = await movs(xm5, "sale");
    expect(sales).toHaveLength(1);
    expect(Number(sales[0]!.quantity)).toBe(-2);
    expect(Number(sales[0]!.unitCostAfter)).toBe(XM5.cost);
    expect(await onHand(xm5)).toBe(XM5.stock - 2);
    expect(await db.webhookEvent.count({ where: { accountId: A } })).toBe(2);

    // the cost in effect at sale time stays frozen after a later cost change
    const soldAt = sales[0]!.occurredAt;
    await appendMovement({ accountId: A, productId: xm5, type: "purchase_in", quantity: 10, unitCost: 800000, occurredAt: new Date(Date.now() + 1000), idempotencyKey: "x1-later", actor: "user" });
    expect(Number(await costAt(A, xm5, soldAt))).toBe(XM5.cost);
    expect(Number((await movs(xm5, "sale"))[0]!.unitCostAfter)).toBe(XM5.cost);

    // dry-run push log, no ML write
    const log = await pushRows("MLA1");
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log.every((r) => r.mode === "dry_run" && r.result === "dry_run")).toBe(true);
    expect(log.find((r) => r.triggerType === "sale")!.requestedQty).toBe(XM5.stock - 2);
    expect(mlWrites()).toEqual([]);
  });

  it("unknown ML user / non-orders topic / order before the cutover change nothing", async () => {
    await world();
    const xm5 = await pid(XM5.ean);
    putOrder(rawOrder(9002, "MLA1", 1));
    await webhook(new Request("http://x", { method: "POST", body: JSON.stringify({ _id: "z1", topic: "orders_v2", resource: "/orders/9002", user_id: 999 }) }));
    await webhook(new Request("http://x", { method: "POST", body: JSON.stringify({ _id: "z2", topic: "items", resource: "/items/MLA1", user_id: 70777001 }) }));
    putOrder(rawOrder(9003, "MLA1", 1, { createdAt: new Date(CUT.getTime() - 86_400_000).toISOString() }));
    await notify(9003);
    await drain();
    expect(await movs(xm5, "sale")).toHaveLength(0);
  });

  it("the cron reconcile catches an order whose webhook was missed, and rejects a bad secret", async () => {
    await world();
    const xm5 = await pid(XM5.ean);
    putOrder(rawOrder(9004, "MLA1", 1));
    const bad = await cronReconcile(new Request("http://x/api/cron/stock-reconcile", { headers: { authorization: "Bearer nope" } }));
    expect(bad.status).toBe(401);
    const ok = await cronReconcile(new Request("http://x/api/cron/stock-reconcile", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    expect(ok.status).toBe(200);
    expect(await movs(xm5, "sale")).toHaveLength(1);
    expect((await db.inventorySettings.findUniqueOrThrow({ where: { accountId: A } })).lastReconcileAt).not.toBeNull();
    expect(mlWrites()).toEqual([]);
  });
});

/* ================================================================================================ 4 */

describe("4. Sale of an unlinked listing", () => {
  it("raises unmatched_sale and writes no movement", async () => {
    await world();
    putOrder(rawOrder(9101, "MLA3", 1));
    await notify(9101);
    const a = await alertsOf("unmatched_sale");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ dedupeKey: "MLA3", itemId: "MLA3", status: "open" });
    expect(await db.stockMovement.count({ where: { accountId: A, type: "sale" } })).toBe(0);
  });

  // KNOWN GAP (X1-G2: pendingSales default is () => 0, so no link_cost_review alert); see X1-report.md. Remove `.fails` when fixed.
  it.fails("linking from the Alerts tab raises the cost review alert; accepting it applies the pending sale", async () => {
    await world();
    const ult = await pid(ULT.ean);
    putOrder(rawOrder(9102, "MLA3", 2));
    await notify(9102);

    const plan = await products().previewLink({ itemId: "MLA3", variationId: null, components: [{ productId: ult, quantity: 1 }], marketplace: ML } as never);
    expect(plan).toBeTruthy();
    await products().link({ itemId: "MLA3", variationId: null, components: [{ productId: ult, quantity: 1 }], marketplace: ML, fillMissing: true } as never);

    // the link alone must not touch stock: the person confirms the cost first
    expect(await movs(ult, "sale")).toHaveLength(0);
    const review = await alertsOf("link_cost_review");
    expect(review).toHaveLength(1); // needs the pending-sales count wired into the linking service
    expect(Number(review[0]!.quantity)).toBe(2);

    await alertsApi().resolve({ id: Number(review[0]!.id), resolution: "Costo aceptado" });
    const sales = await movs(ult, "sale");
    expect(sales).toHaveLength(1); // pending sales applied once the review is resolved
    expect(Number(sales[0]!.quantity)).toBe(-2);
    expect(await onHand(ult)).toBe(ULT.stock - 2);
    expect((await alertsOf("unmatched_sale"))[0]!.status).toBe("resolved");
  });
});

describe("4b. Resolving a cost review alert applies the parked sales (probe, independent of the alert being raised)", () => {
  // KNOWN GAP (X1-G6): nothing calls applyPendingForListing when the alert is resolved; see X1-report.md.
  it.fails("resolve(link_cost_review) through the Alerts router applies the pending sale", async () => {
    await world();
    const ult = await pid(ULT.ean);
    putOrder(rawOrder(9150, "MLA3", 2));
    await notify(9150);
    const l = await db.listingLink.create({ data: { accountId: A, marketplace: ML, itemId: "MLA3", variationId: null } });
    await db.listingLinkComponent.create({ data: { accountId: A, linkId: l.id, productId: BigInt(ult), quantity: 1 } });
    const a = await db.stockAlert.create({
      data: { accountId: A, type: "link_cost_review", status: "open", productId: BigInt(ult), marketplace: ML, itemId: "MLA3", dedupeKey: `link_cost_review:${ML}:MLA3:0`, title: "Confirmar costo", detail: "x" },
    });
    await alertsApi().resolve({ id: Number(a.id), resolution: "Costo aceptado" });
    expect(await movs(ult, "sale")).toHaveLength(1);
  });
});

/* ================================================================================================ 5 */

describe("5. Cancellations and returns", () => {
  it("cancelling an unshipped order restores the stock (and a second cancel notification does not restore twice)", async () => {
    await world();
    const xb = await pid(XB100.ean);
    shipments.set(5001, "ready_to_ship");
    putOrder(rawOrder(9201, "MLA2", 3, { shippingId: 5001 }));
    await notify(9201);
    expect(await onHand(xb)).toBe(XB100.stock - 3);
    putOrder({ ...orders.get(9201)!, status: "cancelled" });
    await notify(9201);
    await notify(9201);
    expect(await onHand(xb)).toBe(XB100.stock);
    expect(await movs(xb, "sale_cancel")).toHaveLength(1);
    expect(await db.returnCase.count({ where: { accountId: A } })).toBe(0);
  });

  it("cancelling a shipped order opens a Pendiente return and does not touch stock", async () => {
    await world();
    const xb = await pid(XB100.ean);
    shipments.set(5002, "shipped");
    putOrder(rawOrder(9202, "MLA2", 1, { shippingId: 5002 }));
    await notify(9202);
    putOrder({ ...orders.get(9202)!, status: "cancelled" });
    await notify(9202);
    await notify(9202);
    expect(await onHand(xb)).toBe(XB100.stock - 1);
    const rc = await db.returnCase.findMany({ where: { accountId: A } });
    expect(rc).toHaveLength(1);
    expect(rc[0]).toMatchObject({ outcome: "pending", lineNo: 0 });
    expect(await movs(xb, "sale_cancel")).toHaveLength(0);
  });

  // KNOWN GAP (X1-G3: returns service never configured in production); see X1-report.md. Remove `.fails` when fixed.
  it.fails("the Returns tab lists it and a person resolves it: in repair, then restocked", async () => {
    await world();
    const xb = await pid(XB100.ean);
    shipments.set(5003, "delivered");
    putOrder(rawOrder(9203, "MLA2", 1, { shippingId: 5003 }));
    await notify(9203);
    putOrder({ ...orders.get(9203)!, status: "cancelled" });
    await notify(9203);

    const list = await returnsApi().list({ outcome: "pending" });
    expect(list).toHaveLength(1);
    const returnId = list[0]!.id;

    await returnsApi().resolve({ returnId, outcome: "in_repair", idempotencyKey: "r1" } as never);
    expect(await inRepair(xb)).toBe(1);
    expect(await onHand(xb)).toBe(XB100.stock - 1);

    await expect(returnsApi().resolve({ returnId, outcome: "restocked", idempotencyKey: "r2" } as never)).rejects.toBeTruthy(); // needs explicit confirm
    await returnsApi().resolve({ returnId, outcome: "restocked", confirmRestock: true, idempotencyKey: "r3" } as never);
    expect(await inRepair(xb)).toBe(0);
    expect(await onHand(xb)).toBe(XB100.stock);
    await expect(returnsApi().resolve({ returnId, outcome: "lost", idempotencyKey: "r4" } as never)).rejects.toBeTruthy(); // terminal
    expect(Number(await recomputeOnHand(A, xb))).toBe(XB100.stock);
  });
});

/* ================================================================================================ 6 */

describe("6. Negative stock", () => {
  async function oversell() {
    await world();
    const xb = await pid(XB100.ean);
    await appendMovement({ accountId: A, productId: xb, type: "manual_adjust", quantity: -(XB100.stock - 1), reason: "Dejar 1 unidad", occurredAt: new Date(), idempotencyKey: "x1-left-1", actor: "user" });
    putOrder(rawOrder(9301, "MLA2", 3));
    await notify(9301);
    return xb;
  }

  it("goes negative internally; ML payload is clamped at 0 in the push log; nothing is written to ML", async () => {
    const xb = await oversell();
    expect(await onHand(xb)).toBe(-2);
    const sale = (await pushRows("MLA2")).filter((r) => r.triggerType === "sale");
    expect(sale).toHaveLength(1);
    expect(sale[0]).toMatchObject({ requestedQty: 0, mode: "dry_run", result: "dry_run" });
    expect((await pushRows()).every((r) => r.requestedQty >= 0)).toBe(true);
    expect(mlWrites()).toEqual([]);
  });

  it("the alert evaluator raises negative_stock and out_of_stock for it", async () => {
    const xb = await oversell();
    await evaluateAlerts(A);
    const neg = await alertsOf("negative_stock");
    expect(neg.map((a) => Number(a.productId))).toContain(xb);
    expect((await alertsOf("out_of_stock")).map((a) => Number(a.productId))).toContain(xb);
    await evaluateAlerts(A); // idempotent: no duplicates
    expect((await alertsOf("negative_stock")).filter((a) => Number(a.productId) === xb)).toHaveLength(1);
  });

  // KNOWN GAP (X1-G4: nothing calls evaluateAlerts after sales); see X1-report.md. Remove `.fails` when fixed.
  it.fails("a sale that makes stock negative raises negative_stock by itself, without anyone calling the evaluator", async () => {
    const xb = await oversell();
    expect(xb).toBeGreaterThan(0);
    expect((await alertsOf("negative_stock")).filter((a) => Number(a.productId) === xb)).toHaveLength(1);
  });
});

/* ================================================================================================ 7 */

describe("7. New P&L Excel after the cutover", () => {
  it("writes excel_reset movements and cost entries with the log text; old sales keep their COGS; the cost lookup is stable", async () => {
    await world();
    const xm5 = await pid(XM5.ean);
    putOrder(rawOrder(9401, "MLA1", 4));
    await notify(9401);
    const sale = (await movs(xm5, "sale"))[0]!;
    expect(await onHand(xm5)).toBe(XM5.stock - 4);
    const before = await loadLedgerCosts(A);
    const costBefore = before!.costAt(xm5, sale.occurredAt);
    // a purchase at another cost after the sale, so the Excel has a cost AND a stock to reset
    await appendMovement({ accountId: A, productId: xm5, type: "purchase_in", quantity: 5, unitCost: 600000, occurredAt: new Date(), idempotencyKey: "x1-pre-excel", actor: "user" });

    await saveUpload(A, "pnl", "PnL_Octubre2026.xlsx", PNL); // the same workbook: stock back to 32 and cost 520000

    const resets = await movs(xm5, "excel_reset");
    expect(resets).toHaveLength(1);
    expect(Number(resets[0]!.quantity)).toBe(-1); // 28 + 5 -> 32
    expect(resets[0]!.reason).toMatch(/^Excel PnL_Octubre2026\.xlsx \d{4}-\d{2}-\d{2}: costo y stock$/);
    expect(await onHand(xm5)).toBe(XM5.stock);
    const entries = await db.productCostEntry.findMany({ where: { accountId: A, productId: BigInt(xm5) } });
    expect(entries.some((e) => e.reason === "excel" && Number(e.unitCost) === XM5.cost)).toBe(true);

    // old sale keeps its frozen cost, however many times the history is recomputed ("Recalcular histórico" x2)
    expect(Number((await movs(xm5, "sale"))[0]!.unitCostAfter)).toBe(XM5.cost);
    const l1 = await loadLedgerCosts(A);
    const l2 = await loadLedgerCosts(A);
    expect(l1!.costAt(xm5, sale.occurredAt)).toBe(costBefore);
    expect(l2!.costAt(xm5, sale.occurredAt)).toBe(l1!.costAt(xm5, sale.occurredAt));
    expect(Number(await recomputeOnHand(A, xm5))).toBe(XM5.stock);
  });

  it("an inputs upload after the cutover ignores the stock-receipts sheet and says so", async () => {
    await world();
    const inputsPath = path.join(ROOT, "demo/Ventas_Directas_DEMO.xlsx");
    const r = await saveUpload(A, "inputs", "Ventas_Directas_DEMO.xlsx", readFileSync(inputsPath));
    expect(r.notice).toMatch(/Ingresos Stock/);
  });
});

/* ================================================================================================ 8 */

describe("8. Go-live of one product against the mocked ML", () => {
  it("shows ML qty vs ours, requires a confirmation, and the only ML write is the single quantity PUT", async () => {
    await world();
    const xm5 = await pid(XM5.ean);
    const preview = await syncApi().goLivePreview({ productId: xm5 });
    expect(preview).toMatchObject({ productId: xm5, ourOnHand: XM5.stock, listings: [{ itemId: "MLA1", variationId: null, mlQty: 30 }] });

    await expect(syncApi().goLive({ confirmations: [] })).rejects.toBeTruthy(); // nothing to confirm -> refused
    expect(mlWrites()).toEqual([]);

    await syncApi().goLive({ confirmations: [{ productId: xm5, openingStock: XM5.stock, idempotencyKey: "golive-xm5-1" }] });
    expect(mlWrites()).toEqual([{ method: "PUT", url: "https://api.mercadolibre.com/items/MLA1", body: { available_quantity: XM5.stock } }]);
    expect(items.get("MLA1")!.qty).toBe(XM5.stock);
    expect((await pushRows("MLA1")).at(-1)).toMatchObject({ mode: "live", result: "ok", requestedQty: XM5.stock });
    // the other product stays in dry-run and untouched
    expect(items.get("MLA2")!.qty).toBe(10);
    const states = await syncApi().status();
    expect(states.find((s) => s.itemId === "MLA2")).toMatchObject({ mode: "dry_run" });

    // live: a sale pushes the new quantity, still one PUT per event and nothing but available_quantity
    putOrder(rawOrder(9501, "MLA1", 1));
    await notify(9501);
    expect(mlWrites().map((c) => [c.method, c.url, c.body])).toEqual([
      ["PUT", "https://api.mercadolibre.com/items/MLA1", { available_quantity: XM5.stock }],
      ["PUT", "https://api.mercadolibre.com/items/MLA1", { available_quantity: XM5.stock - 1 }],
    ]);
  });

  // KNOWN GAP (X1-G5: push engine appendMovement default throws); see X1-report.md. Remove `.fails` when fixed.
  it.fails("an edited opening stock is written as a manual_adjust with the go-live reason, then pushed", async () => {
    await world();
    const xm5 = await pid(XM5.ean);
    await syncApi().goLive({ confirmations: [{ productId: xm5, openingStock: 25, idempotencyKey: "golive-xm5-2" }] });
    expect(await onHand(xm5)).toBe(25);
    const adj = (await movs(xm5, "manual_adjust"))[0]!;
    expect(adj.reason).toMatch(/Stock inicial confirmado/);
    expect(mlWrites()).toEqual([{ method: "PUT", url: "https://api.mercadolibre.com/items/MLA1", body: { available_quantity: 25 } }]);
  });

  it("back to dry-run stops the writes", async () => {
    await world();
    const xm5 = await pid(XM5.ean);
    await syncApi().goLive({ confirmations: [{ productId: xm5, openingStock: XM5.stock, idempotencyKey: "golive-xm5-3" }] });
    await syncApi().setDryRun({});
    calls.length = 0;
    putOrder(rawOrder(9502, "MLA1", 1));
    await notify(9502);
    expect(mlWrites()).toEqual([]);
  });
});

/* ================================================================================================ 9 */

describe("9. Dashboard cleanup, badge, sidebar, market-research index (server-visible parts)", () => {
  const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

  it("the alerts counts endpoint feeds the badge, and the badge links to /stock/alerts", async () => {
    await world();
    putOrder(rawOrder(9601, "MLA3", 1));
    await notify(9601);
    const c = await alertsApi().counts();
    expect(c.total).toBeGreaterThan(0);
    expect(c.byType.unmatched_sale).toBe(1);
    expect(read("src/app/_components/shell/AlertsBadge.tsx")).toContain('href="/stock/alerts"');
  });

  it("the dashboard no longer renders a stock table or the alerts card", () => {
    const dash = read("src/app/_components/dashboard/index.tsx");
    expect(dash).not.toMatch(/StockTable|AlertsCard|<StockSection/);
    expect(read("src/app/_components/dashboard/Dashboard.tsx")).toContain("AlertsBadge");
  });

  it("the sidebar starts collapsed", () => {
    expect(read("src/app/_components/shell/AppShell.tsx")).toMatch(/useState\(false\)[^\n]*collapsed by default/);
  });
});

describe("manual stock adjustment from the Products tab", () => {
  // KNOWN GAP (X1-G5): the products router uses the same unwired ledger stand-in; see X1-report.md.
  it.fails("adjustStock writes a manual_adjust through the ledger and pushes", async () => {
    await world();
    const xm5 = await pid(XM5.ean);
    const r = await products().adjustStock({ productId: xm5, delta: -2, reason: "Conteo físico", idempotencyKey: "adj-1" } as never);
    expect(r.onHand).toBe(XM5.stock - 2);
    expect(await movs(xm5, "manual_adjust")).toHaveLength(1);
  });
});

/* ================================================================================================ cross-cutting */

describe("cross-cutting guarantees", () => {
  it("one account never sees or changes another's stock (tenant isolation across the whole loop)", async () => {
    await world();
    await ensureAccount(OTHER);
    putOrder(rawOrder(9701, "MLA1", 1));
    await notify(9701);
    expect(await db.stockMovement.count({ where: { accountId: OTHER } })).toBe(0);
    expect(await products(OTHER).list()).toEqual([]);
    expect(await alertsApi(OTHER).counts()).toMatchObject({ total: 0 });
  });

  it("across a full session of sales, cancels and an invoice, the ledger always equals the cached balance and ML only ever got GETs", async () => {
    await world();
    putOrder(rawOrder(9801, "MLA1", 2));
    putOrder(rawOrder(9802, "MLA2", 1));
    await notify(9801);
    await notify(9802);
    putOrder({ ...orders.get(9802)!, status: "cancelled" });
    await notify(9802);
    for (const p of await db.inventoryProduct.findMany({ where: { accountId: A } })) {
      expect(Number(await recomputeOnHand(A, Number(p.id)))).toBe(Number(p.onHand));
    }
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});
