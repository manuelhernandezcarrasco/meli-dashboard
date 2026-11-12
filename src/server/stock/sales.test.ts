import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s4";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("~/server/ml/tokens", () => ({
  tokenAuthFor: () => ({ getAccessToken: () => Promise.resolve("tok"), refresh: () => Promise.resolve() }),
}));

import type { Order } from "~/lib/contracts";
import { db } from "~/server/db";
import { ensureAccount } from "~/server/store/bulk";
import { appendMovement } from "./ledger";
import { createSales, type SalesDeps } from "./sales";

const A = "s4_sales_a";
const B = "s4_sales_b";
const CUTOVER = new Date("2026-10-01T00:00:00-03:00");

let orders: Map<number, Order>;
let shipments: Map<number, string>;
let pushes: { productIds: number[]; ref?: string }[];
let alerts: { type: string; dedupeKey: string }[];
let resolved: string[];
let returns: { orderId: number; lineNo: number; productId: number; quantity: number }[];
let compared: string[];
let searchSince: Date | null;

type Line = Order["items"][number];
const order = (id: number, o: Partial<Omit<Order, "items">> & { items?: Partial<Line>[] } = {}): Order => ({
  id, packId: null, status: "paid", dateCreated: "2026-10-05T10:00:00.000-03:00", shippingId: null,
  payments: [{ id: id * 10, status: "approved" }],
  ...o,
  items: (o.items ?? [{}]).map((it) => ({
    itemId: "MLA1", title: "Cámara", sellerSku: null, sellerCustomField: null, variationId: null, quantity: 1, unitPrice: 100, saleFee: 10, ...it,
  })),
});
const put = (...os: Order[]) => os.forEach((o) => orders.set(o.id, o));

const sales = (over: Partial<SalesDeps> = {}) =>
  createSales({
    ml: {
      fetchOrder: async (_a, id) => orders.get(id) ?? null,
      searchOrders: async (_a, since) => { searchSince = since; return [...orders.values()]; },
      shipmentStatus: async (_a, id) => shipments.get(id) ?? null,
    },
    raiseAlert: async (i) => { alerts.push(i); return { alertId: 1, created: true }; },
    resolveAlert: async (_a, key) => { resolved.push(key); },
    requestPush: async (_a, productIds, t) => { pushes.push({ productIds, ref: t.ref }); },
    compareWithMl: async (a) => { compared.push(a); },
    openReturn: async (i) => { returns.push(i); },
    ...over,
  });

async function product(name: string, stock: number, cost = 50): Promise<number> {
  const p = await db.inventoryProduct.create({ data: { accountId: A, name } });
  const id = Number(p.id);
  await appendMovement({ accountId: A, productId: id, type: "initial_count", quantity: stock, unitCost: cost, occurredAt: new Date("2026-09-30T00:00:00-03:00"), idempotencyKey: `init:${id}`, actor: "system" });
  return id;
}
async function link(itemId: string, variationId: number | null, components: { productId: number; quantity: number }[]) {
  const l = await db.listingLink.create({ data: { accountId: A, marketplace: "mercadolibre", itemId, variationId } });
  await db.listingLinkComponent.createMany({ data: components.map((c) => ({ accountId: A, linkId: l.id, ...c })) });
}
const onHand = async (id: number) => Number((await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_id: { accountId: A, id: BigInt(id) } } })).onHand);
const movements = (type?: string) => db.stockMovement.findMany({ where: { accountId: A, ...(type ? { type: type as never } : {}) }, orderBy: { id: "asc" } });

beforeEach(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await ensureAccount(A);
  await ensureAccount(B);
  await db.inventorySettings.create({ data: { accountId: A, cutoverAt: CUTOVER } });
  orders = new Map(); shipments = new Map(); pushes = []; alerts = []; resolved = []; returns = []; compared = []; searchSince = null;
});
afterAll(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await db.$disconnect();
});

describe("applyOrder", () => {
  it("a paid linked order writes one sale movement and asks for a push; repeating it changes nothing", async () => {
    const p = await product("Cámara", 10);
    await link("MLA1", null, [{ productId: p, quantity: 1 }]);
    put(order(1001, { items: [{ quantity: 2 }] }));
    const s = sales();
    await s.applyOrder(A, 1001);
    await s.applyOrder(A, 1001);
    const sale = await movements("sale");
    expect(sale).toHaveLength(1);
    expect(sale[0]).toMatchObject({ idempotencyKey: `sale:1001:0:${p}`, refType: "order", refId: "1001:0", actor: "webhook" });
    expect(Number(sale[0]!.quantity)).toBe(-2);
    expect(sale[0]!.occurredAt.toISOString()).toBe(new Date("2026-10-05T10:00:00-03:00").toISOString());
    expect(await onHand(p)).toBe(8);
    expect(pushes[0]).toEqual({ productIds: [p], ref: "1001" });
    expect(await db.order.count({ where: { accountId: A } })).toBe(1); // stored through saveOrders
  });

  it("combo components multiply the quantity", async () => {
    const p1 = await product("A", 20);
    const p2 = await product("B", 20);
    await link("MLA1", null, [{ productId: p1, quantity: 1 }, { productId: p2, quantity: 3 }]);
    put(order(1002, { items: [{ quantity: 2 }] }));
    await sales().applyOrder(A, 1002);
    expect(await onHand(p1)).toBe(18);
    expect(await onHand(p2)).toBe(14);
  });

  it("an unlinked sale raises unmatched_sale and writes no movement", async () => {
    await product("Cámara", 10);
    put(order(1003));
    const r = await sales().applyOrder(A, 1003);
    expect(await movements("sale")).toHaveLength(0);
    expect(alerts).toEqual([expect.objectContaining({ type: "unmatched_sale", dedupeKey: "MLA1" })]);
    expect(r).toMatchObject({ unmatched: 1, movements: 0 });
    expect(pushes).toEqual([]);
  });

  it("a pack with several lines writes one movement per line, variation links win over listing links", async () => {
    const p1 = await product("A", 10);
    const p2 = await product("B", 10);
    const p3 = await product("C", 10);
    await link("MLA1", 7, [{ productId: p1, quantity: 1 }]);
    await link("MLA1", null, [{ productId: p3, quantity: 1 }]);
    await link("MLA2", null, [{ productId: p2, quantity: 1 }]);
    put(order(1004, { packId: 55, items: [{ itemId: "MLA1", variationId: 7, quantity: 1 }, { itemId: "MLA2", quantity: 2 }, { itemId: "MLA1", variationId: 9, quantity: 1 }] }));
    await sales().applyOrder(A, 1004);
    expect(await onHand(p1)).toBe(9);
    expect(await onHand(p2)).toBe(8);
    expect(await onHand(p3)).toBe(9); // variation 9 has no link of its own: falls back to the listing link
    expect((await movements("sale")).map((m) => m.idempotencyKey).sort()).toEqual([`sale:1004:0:${p1}`, `sale:1004:1:${p2}`, `sale:1004:2:${p3}`].sort());
  });

  it("ignores orders created before the cutover, and unpaid statuses", async () => {
    const p = await product("Cámara", 10);
    await link("MLA1", null, [{ productId: p, quantity: 1 }]);
    put(order(1005, { dateCreated: "2026-09-30T23:59:00.000-03:00" }), order(1006, { status: "payment_required" }));
    const s = sales();
    expect(await s.applyOrder(A, 1005)).toEqual({ status: "pre_cutover" });
    expect(await s.applyOrder(A, 1006)).toEqual({ status: "ignored" });
    expect(await movements("sale")).toHaveLength(0);
    expect(alerts).toEqual([]);
  });

  it("does nothing before the cutover is done", async () => {
    await db.inventorySettings.update({ where: { accountId: A }, data: { cutoverAt: null } });
    put(order(1007));
    expect(await sales().applyOrder(A, 1007)).toEqual({ status: "no_cutover" });
  });

  it("an unknown order is reported, not thrown", async () => {
    expect(await sales().applyOrder(A, 999)).toEqual({ status: "not_found" });
  });
});

describe("cancellations", () => {
  async function sold(shippingId: number | null, status?: string) {
    const p = await product("Cámara", 10);
    await link("MLA1", null, [{ productId: p, quantity: 1 }]);
    put(order(2001, { shippingId, items: [{ quantity: 2 }] }));
    if (shippingId && status) shipments.set(shippingId, status);
    const s = sales();
    await s.applyOrder(A, 2001);
    put(order(2001, { shippingId, status: "cancelled", items: [{ quantity: 2 }] }));
    return { p, s };
  }

  it("before shipping: a sale_cancel restores the units once", async () => {
    const { p, s } = await sold(500, "ready_to_ship");
    pushes.length = 0;
    await s.applyOrder(A, 2001);
    const firstPushes = pushes.length;
    await s.applyOrder(A, 2001); // a repeat re-requests the push (idempotent by design) but writes nothing
    const c = await movements("sale_cancel");
    expect(c).toHaveLength(1);
    expect(Number(c[0]!.quantity)).toBe(2);
    expect(await onHand(p)).toBe(10);
    expect(firstPushes).toBe(1);
    expect(pushes[0]).toEqual({ productIds: [p], ref: "2001" });
    expect(returns).toEqual([]);
  });

  it("an order without shipment counts as not shipped", async () => {
    const { p, s } = await sold(null);
    await s.applyOrder(A, 2001);
    expect(await onHand(p)).toBe(10);
  });

  it.each(["shipped", "delivered"])("when %s: no movement, a pending return case is opened", async (status) => {
    const { p, s } = await sold(501, status);
    await s.applyOrder(A, 2001);
    expect(await movements("sale_cancel")).toHaveLength(0);
    expect(await onHand(p)).toBe(8);
    expect(returns).toEqual([{ accountId: A, orderId: 2001, lineNo: 0, productId: p, quantity: 2, reason: expect.any(String) }]);
  });

  it("a cancelled order that never had a sale does nothing", async () => {
    await product("Cámara", 10);
    put(order(2002, { status: "cancelled" }));
    await sales().applyOrder(A, 2002);
    expect(await movements()).toHaveLength(1); // only the opening count
    expect(returns).toEqual([]);
  });
});

describe("retroactive apply", () => {
  it("applies parked sales oldest first once the listing is linked, then clears the alert", async () => {
    const p = await product("Cámara", 10);
    put(
      order(3002, { dateCreated: "2026-10-07T10:00:00.000-03:00", items: [{ quantity: 1 }] }),
      order(3001, { dateCreated: "2026-10-06T10:00:00.000-03:00", items: [{ quantity: 2 }] }),
      order(3003, { dateCreated: "2026-09-20T10:00:00.000-03:00" }), // before cutover: never applied
      order(3004, { dateCreated: "2026-10-08T10:00:00.000-03:00", status: "cancelled" }),
    );
    const s = sales();
    for (const id of [3001, 3002, 3003, 3004]) await s.applyOrder(A, id);
    expect(await s.pendingSalesCount(A, "MLA1", null)).toBe(2);

    await link("MLA1", null, [{ productId: p, quantity: 1 }]);
    pushes.length = 0;
    expect(await s.applyPendingForListing(A, "MLA1", null)).toBe(2);
    const sale = await movements("sale");
    expect(sale.map((m) => m.refId)).toEqual(["3001:0", "3002:0"]); // chronological
    expect(await onHand(p)).toBe(7);
    expect(pushes).toEqual([{ productIds: [p], ref: "pending:MLA1" }]);
    expect(resolved).toEqual(["MLA1"]);
    expect(await s.pendingSalesCount(A, "MLA1", null)).toBe(0);
    expect(await s.applyPendingForListing(A, "MLA1", null)).toBe(0); // idempotent
    expect(await onHand(p)).toBe(7);
  });

  it("keeps lines of other variations parked and the alert open", async () => {
    const p = await product("Cámara", 10);
    put(order(3101, { items: [{ variationId: 1 }] }), order(3102, { items: [{ variationId: 2 }] }));
    const s = sales();
    await s.applyOrder(A, 3101);
    await s.applyOrder(A, 3102);
    await link("MLA1", 1, [{ productId: p, quantity: 1 }]);
    expect(await s.applyPendingForListing(A, "MLA1", 1)).toBe(1);
    expect(resolved).toEqual([]);
    expect(await s.pendingSalesCount(A, "MLA1", 2)).toBe(1);
  });
});

describe("account isolation and locking", () => {
  it("concurrent applies of the same order still produce one movement", async () => {
    const p = await product("Cámara", 10);
    await link("MLA1", null, [{ productId: p, quantity: 1 }]);
    put(order(4001));
    const s = sales();
    await Promise.all([s.applyOrder(A, 4001), s.applyOrder(A, 4001), s.reconcileAccount(A)]);
    expect(await movements("sale")).toHaveLength(1);
    expect(await onHand(p)).toBe(9);
  });
});

describe("reconcile", () => {
  it("catches an order whose webhook never arrived, compares with ML and stamps lastReconcileAt", async () => {
    const p = await product("Cámara", 10);
    await link("MLA1", null, [{ productId: p, quantity: 1 }]);
    put(order(5001), order(5002, { dateCreated: "2026-09-01T10:00:00.000-03:00" }));
    const now = new Date("2026-10-10T12:00:00Z");
    const s = sales({ now: () => now });
    const r = await s.reconcileAccount(A);
    expect(r).toMatchObject({ orders: 2, applied: 1, errors: 0 });
    expect(await onHand(p)).toBe(9);
    expect(compared).toEqual([A]);
    expect(searchSince).toEqual(CUTOVER); // first run: from the cutover
    expect((await db.inventorySettings.findUniqueOrThrow({ where: { accountId: A } })).lastReconcileAt).toEqual(now);

    await s.reconcileAccount(A);
    expect(searchSince).toEqual(new Date(now.getTime() - 86_400_000)); // later runs: lastReconcileAt - 1 day
    expect(await movements("sale")).toHaveLength(1);
  });

  it("applies a cancellation the webhook missed", async () => {
    const p = await product("Cámara", 10);
    await link("MLA1", null, [{ productId: p, quantity: 1 }]);
    put(order(5101));
    const s = sales();
    await s.applyOrder(A, 5101);
    put(order(5101, { status: "cancelled" }));
    await s.reconcileAccount(A);
    expect(await onHand(p)).toBe(10);
  });

  it("does not advance lastReconcileAt when an order fails, and keeps going", async () => {
    const p = await product("Cámara", 10);
    await link("MLA1", null, [{ productId: p, quantity: 1 }]);
    put(order(5201), order(5202));
    let n = 0;
    const s = sales({ requestPush: async () => { if (n++ === 0) throw new Error("boom"); } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await s.reconcileAccount(A);
    expect(r).toMatchObject({ orders: 2, errors: 1 });
    expect(await movements("sale")).toHaveLength(2); // the failure came after the movement; the retry is idempotent
    expect((await db.inventorySettings.findUniqueOrThrow({ where: { accountId: A } })).lastReconcileAt).toBeNull();
  });

  it("skips accounts without cutover", async () => {
    await db.inventorySettings.update({ where: { accountId: A }, data: { cutoverAt: null } });
    expect(await sales().reconcileAccount(A)).toMatchObject({ orders: 0 });
    expect(searchSince).toBeNull();
  });

  it("reconcileAll visits only connected accounts with a cutover", async () => {
    await db.marketplaceConnection.create({ data: { accountId: A, marketplace: "mercadolibre", externalUserId: "u-a", accessToken: "x", refreshToken: "y", expiresAt: new Date() } });
    await db.marketplaceConnection.create({ data: { accountId: B, marketplace: "mercadolibre", externalUserId: "u-b", accessToken: "x", refreshToken: "y", expiresAt: new Date() } });
    const r = await sales().reconcileAll();
    expect(r.map((x) => x.accountId)).toEqual([A]);
  });
});
