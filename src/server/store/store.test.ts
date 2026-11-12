import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_t6";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));

import type { Line, Order } from "~/lib/contracts";
import type { MarketPoint, MarketResearch } from "~/lib/market";
import { db } from "~/server/db";
import { MERCADOLIBRE } from "./marketplace";
import {
  getCatalogId, readListings, saveCatalogIds, saveGtins, saveListingMatches, searchListings, setCatalogId,
} from "./listings";
import { loadLatestScan, saveScan } from "./market";
import { isPeriodFinal, loadOrdersMonth, markPeriod, saveOrders } from "./orders";
import { readPaymentTaxes, savePaymentTaxes } from "./payments";
import { replaceSaleLines } from "./saleLines";
import { readSellerNicknames, saveSellerNicknames } from "./sellers";
import { readShipments, saveShipmentCosts } from "./shipments";

/** Sellers are global, so the test uses ids no real seller has and removes them afterwards. */
const SELLER_OURS = 990_000_001;
const ML = MERCADOLIBRE;
const A = "store_user_a";
const B = "store_user_b";

const order = (id: number, iso: string, over: Partial<Order> = {}): Order => ({
  id,
  packId: null,
  status: "paid",
  dateCreated: iso,
  shippingId: id + 1_000_000,
  items: [
    { itemId: "MLA1", title: "Cámara Sony", sellerSku: "", sellerCustomField: null, variationId: null, quantity: 2, unitPrice: 1500.5, saleFee: 210.25 },
  ],
  payments: [{ id: id + 5_000_000, status: "approved" }],
  ...over,
});

const SEP_1 = "2026-09-01T00:00:00.000-03:00"; // first instant of Argentine September
const SEP_30 = "2026-09-30T23:59:59.999-03:00"; // last one
const OCT_1 = "2026-10-01T00:00:00.000-03:00";

beforeEach(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
});
afterAll(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await db.seller.deleteMany({ where: { sellerId: { gte: BigInt(SELLER_OURS), lte: BigInt(SELLER_OURS + 3) } } });
  await db.$disconnect();
});

describe("orders", () => {
  const orders = [
    order(2000000000001, SEP_1),
    order(2000000000002, "2026-09-15T10:30:00.123-03:00", {
      packId: 2000000000099,
      items: [
        { itemId: "MLA1", title: "Cámara Sony", sellerSku: "SKU-1", sellerCustomField: "CF", variationId: 77, quantity: 1, unitPrice: 10, saleFee: 1 },
        { itemId: "MLA2", title: "Trípode", sellerSku: null, sellerCustomField: null, variationId: null, quantity: 3, unitPrice: 99.99, saleFee: 9.5 },
      ],
      payments: [{ id: 2090000000001, status: "approved" }, { id: 2090000000002, status: "refunded" }],
    }),
    order(2000000000003, SEP_30, { shippingId: null, status: "cancelled", payments: [] }),
  ];

  it("round-trips exactly, scoped to the Argentine month of each order", async () => {
    await saveOrders(A, ML, [...orders, order(2000000000004, OCT_1)]);
    expect(await loadOrdersMonth(A, ML, 2026, 9)).toEqual(orders);
    expect((await loadOrdersMonth(A, ML, 2026, 10)).map((o) => o.id)).toEqual([2000000000004]);
    expect(await loadOrdersMonth(B, ML, 2026, 9)).toEqual([]);
  });

  it("assigns an order to the month of its own instant, even when another month's download delivered it", async () => {
    // real case: the seller's clock is -04:00 and Mercado Libre filters months in it, so this order
    // (00:34 on June 1st in Argentina) arrives in the MAY download and may arrive in June's too
    const boundary = order(2000000000010, "2026-05-31T23:34:09.000-04:00");
    await saveOrders(A, ML, [boundary]); // delivered by the May download...
    await saveOrders(A, ML, [boundary]); // ...and again by the June one: one row, not two
    expect((await loadOrdersMonth(A, ML, 2026, 6)).map((o) => o.id)).toEqual([boundary.id]);
    expect(await loadOrdersMonth(A, ML, 2026, 5)).toEqual([]);
    expect((await loadOrdersMonth(A, ML, 2026, 6))[0]!.dateCreated).toBe("2026-06-01T00:34:09.000-03:00"); // same instant
    expect(await db.order.count({ where: { accountId: A } })).toBe(1);
  });

  it("is idempotent: saving the same orders again rewrites nothing", async () => {
    await saveOrders(A, ML, orders);
    const stamps = async () =>
      (await db.order.findMany({ where: { accountId: A }, orderBy: { orderId: "asc" }, select: { updatedAt: true } })).map((o) => o.updatedAt.getTime());
    const before = await stamps();
    await new Promise((r) => setTimeout(r, 15));
    await saveOrders(A, ML, orders);
    expect(await stamps()).toEqual(before);
    expect(await db.orderItem.count({ where: { accountId: A } })).toBe(4);
  });

  it("drops lines and payments an order no longer has, and applies changes", async () => {
    await saveOrders(A, ML, orders);
    const changed = { ...orders[1]!, status: "cancelled", items: [orders[1]!.items[0]!], payments: [{ id: 2090000000001, status: "approved" }] };
    await saveOrders(A, ML, [changed]);
    const [o] = (await loadOrdersMonth(A, ML, 2026, 9)).filter((x) => x.id === changed.id);
    expect(o).toEqual(changed);
  });

  it("keeps tenants apart even with the same Mercado Libre ids", async () => {
    await saveOrders(A, ML, [order(1, SEP_1, { items: [{ ...orders[0]!.items[0]!, title: "de A" }] })]);
    await saveOrders(B, ML, [order(1, SEP_1, { items: [{ ...orders[0]!.items[0]!, title: "de B" }] })]);
    expect((await loadOrdersMonth(A, ML, 2026, 9))[0]!.items[0]!.title).toBe("de A");
    expect((await loadOrdersMonth(B, ML, 2026, 9))[0]!.items[0]!.title).toBe("de B");
  });

  it("tracks which months are final", async () => {
    expect(await isPeriodFinal(A, ML, "2026-09")).toBe(false);
    await db.account.createMany({ data: [{ id: A }], skipDuplicates: true });
    await markPeriod(A, ML, "2026-09", false, 3);
    expect(await isPeriodFinal(A, ML, "2026-09")).toBe(false);
    await markPeriod(A, ML, "2026-09", true, 3);
    expect(await isPeriodFinal(A, ML, "2026-09")).toBe(true);
  });

  it("deleting an account removes everything it owns, in one statement", async () => {
    await saveOrders(A, ML, orders);
    await saveShipmentCosts(A, ML, { "1000001": 50 });
    await savePaymentTaxes(A, ML, [["5000001", { total: 1, det: { IVA: 1 }, financing: 0 }]]);
    await saveGtins(A, ML, { MLA1: { _item: "779", "5": "780" } });
    await replaceSaleLines(A, ML, "2026-09", [line()]);
    await saveScan(A, ML, research("MLA-C1", "2026-11-01T00:00:00.000Z"));
    await saveOrders(B, ML, [order(9, SEP_1)]);
    await db.account.deleteMany({ where: { id: A } });
    expect(await db.order.count({ where: { accountId: A } })).toBe(0);
    expect(await db.orderItem.count({ where: { accountId: A } })).toBe(0);
    expect(await db.listing.count({ where: { accountId: A } })).toBe(0);
    expect(await db.saleLine.count({ where: { accountId: A } })).toBe(0);
    expect(await db.marketScan.count({ where: { accountId: A } })).toBe(0);
    expect(await db.order.count({ where: { accountId: B } })).toBe(1);
  });
});

describe("shipments and payment taxes", () => {
  it("stores shipment costs, negatives included, and reports what was never asked", async () => {
    await saveShipmentCosts(A, ML, { "10": 120.5, "11": -42.25 });
    const got = await readShipments(A, ML, ["10", "11", "12"]);
    expect(got.get("10")?.cost).toBe(120.5);
    expect(got.get("11")?.cost).toBe(-42.25);
    expect(got.get("10")?.fetchedAt).toBeInstanceOf(Date);
    expect(got.has("12")).toBe(false);
  });

  it("stores taxes with their detail, 'no detail' as asked-but-null, and replaces detail on update", async () => {
    await savePaymentTaxes(A, ML, [
      ["1", { total: 30, det: { IVA: 10, "IIBB Retención CABA": 20 }, financing: 5.5 }],
      ["2", null],
    ]);
    let got = await readPaymentTaxes(A, ML, ["1", "2", "3"]);
    expect(got.get("1")?.taxes).toEqual({ total: 30, det: { IVA: 10, "IIBB Retención CABA": 20 }, financing: 5.5 });
    expect(got.get("2")).toMatchObject({ taxes: null, legacyNoFinancing: false });
    expect(got.get("2")?.fetchedAt).toBeInstanceOf(Date);
    expect(got.has("3")).toBe(false);

    await savePaymentTaxes(A, ML, [["1", { total: 7, det: { IVA: 7 }, financing: 0 }]]);
    got = await readPaymentTaxes(A, ML, ["1"]);
    expect(got.get("1")?.taxes).toEqual({ total: 7, det: { IVA: 7 }, financing: 0 });
    expect(await db.paymentTax.count({ where: { accountId: A, paymentId: 1n } })).toBe(1);
  });

  it("flags entries that predate the financing split so they are asked again once", async () => {
    await db.account.createMany({ data: [{ id: A }], skipDuplicates: true });
    await db.payment.create({ data: { accountId: A, marketplace: ML, paymentId: 5n, taxTotal: 12.5, taxFetchedAt: new Date() } });
    expect((await readPaymentTaxes(A, ML, ["5"])).get("5")).toMatchObject({ legacyNoFinancing: true });
  });
});

describe("listings", () => {
  it("round-trips GTINs with variations and distinguishes 'no GTIN' from 'never asked'", async () => {
    await saveGtins(A, ML, { MLA1: { _item: "7790001", "55": "7790055" }, MLA2: { _item: "" } });
    const got = await readListings(A, ML, ["MLA1", "MLA2", "MLA3"]);
    expect(got.get("MLA1")?.gtins).toEqual({ _item: "7790001", "55": "7790055" });
    expect(got.get("MLA2")?.gtins).toEqual({ _item: "" });
    expect(got.get("MLA2")?.gtinCheckedAt).toBeInstanceOf(Date);
    expect(got.has("MLA3")).toBe(false);
    await saveGtins(A, ML, { MLA1: { _item: "7790001" } }); // a variation that disappeared is removed
    expect((await readListings(A, ML, ["MLA1"])).get("MLA1")?.gtins).toEqual({ _item: "7790001" });
  });

  it("remembers catalog ids, including 'none', and tells unknown from none", async () => {
    expect(await getCatalogId(A, ML, "MLA9")).toBeUndefined();
    await setCatalogId(A, ML, "MLA9", null);
    expect(await getCatalogId(A, ML, "MLA9")).toBeNull();
    await saveCatalogIds(A, ML, { MLA9: "MLA-C9", MLA8: null });
    expect(await getCatalogId(A, ML, "MLA9")).toBe("MLA-C9");
    expect(await getCatalogId(B, ML, "MLA9")).toBeUndefined();
  });

  it("searches title and Excel description, ignoring case and accents, never across tenants", async () => {
    await db.account.createMany({ data: [{ id: A }], skipDuplicates: true });
    await db.product.create({
      data: { accountId: A, ean: "779", description: "Auriculares Inalámbricos", model: "", category: "SONY", unitCost: 1, stockFinal: 1, assumedMargin: 0.3, prevUnits: 0, position: 0 },
    });
    await saveListingMatches(A, ML, [
      { itemId: "MLA1", title: "Cámara Sony Alpha", ean: "", desc: "" },
      { itemId: "MLA2", title: "WF-1000XM5 Negro", ean: "779", desc: "Auriculares Inalámbricos" },
      { itemId: "MLA3", title: "Descuento 50% oferta", ean: "", desc: "" },
    ]);
    await saveListingMatches(B, ML, [{ itemId: "MLA1", title: "Cámara de B", ean: "", desc: "" }]);
    expect((await searchListings(A, ML, "camara sony", 10)).map((x) => x.itemId)).toEqual(["MLA1"]);
    expect(await searchListings(A, ML, "inalambricos", 10)).toEqual([{ itemId: "MLA2", title: "WF-1000XM5 Negro", desc: "Auriculares Inalámbricos" }]);
    expect((await searchListings(A, ML, "50%", 10)).map((x) => x.itemId)).toEqual(["MLA3"]); // % is literal
    expect(await searchListings(A, ML, "100% sin match", 10)).toEqual([]);
    expect(await searchListings(A, ML, "de b", 10)).toEqual([]);
  });
});

const line = (over: Partial<Line> = {}): Line => ({
  date: "2026-09-10", time: "14:05", channel: "ML", order: "2000000000001", itemId: "MLA1", sku: "", ean: "779",
  matchVia: "GTIN publicación", desc: "Auriculares", titleMl: "WF-1000XM5", cat: "SONY", qty: 2, pu: 100, venta: 200,
  cargoVenta: 20, cuotas: 5, envio: 10, impEst: 8, costoMl: 43, cu: 60, costSource: "Real (CU Pond. cierre)",
  taxSource: "Mercado Pago", taxDetail: "IVA 8", ...over,
});

describe("sale lines", () => {
  it("replaces a whole month and leaves other months and tenants alone", async () => {
    await replaceSaleLines(A, ML, "2026-09", [line(), line({ date: "2026-09-11", qty: 1, venta: 100, costoMl: 20 })]);
    await replaceSaleLines(A, ML, "2026-10", [line({ date: "2026-10-02" })]);
    await replaceSaleLines(B, ML, "2026-09", [line()]);
    await replaceSaleLines(A, ML, "2026-09", [line({ channel: "VA", itemId: "", ean: "", cat: "SIN MATCH", time: "", taxDetail: "" })]);
    const sep = await db.saleLine.findMany({ where: { accountId: A, period: "2026-09" } });
    expect(sep).toHaveLength(1);
    expect(sep[0]).toMatchObject({ channel: "direct", marketplace: null, itemId: null, ean: null, saleTime: "", taxDetail: null });
    expect(await db.saleLine.count({ where: { accountId: A, period: "2026-10" } })).toBe(1);
    expect(await db.saleLine.count({ where: { accountId: B } })).toBe(1);
  });

  it("stores the cost breakdown so margin is one SQL expression", async () => {
    await replaceSaleLines(A, ML, "2026-09", [line()]);
    const [r] = await db.$queryRaw<{ margin: string; cogs: string; mkt: string }[]>`
      SELECT (revenue - "marketplaceCost" - cogs)::text AS margin, cogs::text, "marketplaceCost"::text AS mkt
      FROM "SaleLine" WHERE "accountId" = ${A}`;
    expect(Number(r!.cogs)).toBe(120);
    expect(Number(r!.mkt)).toBe(43);
    expect(Number(r!.margin)).toBe(37);
  });
});

const point = (itemId: string, sellerId: number, over: Partial<MarketPoint> = {}): MarketPoint => ({
  itemId, sellerId, sellerNickname: String(sellerId), title: "Catalogo X", price: 1000, soldQuantity: null, soldExact: false,
  permalink: `https://articulo.mercadolibre.com.ar/${itemId.replace(/^([A-Z]{3})(\d+)$/, "$1-$2")}`, isOurs: false, ...over,
});
const research = (catalogProductId: string, fetchedAt: string): MarketResearch => ({
  catalogProductId,
  catalogTitle: "Catalogo X",
  fetchedAt,
  points: [
    point("MLA101", SELLER_OURS, { sellerNickname: "NOSOTROS", title: "Nuestro título", price: 1010, soldQuantity: 12, soldExact: true, isOurs: true, permalink: "https://articulo.mercadolibre.com.ar/MLA-101-nuestro-_JM" }),
    point("MLA102", 5002, { price: 1020 }),
  ],
  excluded: [{ point: point("MLA103", 5003, { price: 99999 }), reason: "price_outlier" }, { point: point("MLA104", 5004), reason: "cap" }],
  regression: { log: { mode: "log", slope: 1.5, intercept: 2, r2: 0.5, n: 3 }, linear: null },
});

describe("market scans", () => {
  it("round-trips a research, resolving nicknames through the global Seller table", async () => {
    await saveSellerNicknames(ML, [[SELLER_OURS, "NOSOTROS"]]);
    const r = research("MLA-C1", "2026-11-01T12:00:00.000Z");
    await saveScan(A, ML, r);
    expect(await loadLatestScan(A, ML, "MLA-C1")).toEqual(r);
    expect(await loadLatestScan(B, ML, "MLA-C1")).toBeNull();
    // derived values are stored once: no repeated catalog title nor canonical permalink
    const offers = await db.marketOffer.findMany({ where: { scan: { accountId: A } }, orderBy: { position: "asc" } });
    expect(offers.map((o) => [o.title, o.permalink])).toEqual([
      ["Nuestro título", "https://articulo.mercadolibre.com.ar/MLA-101-nuestro-_JM"], [null, null], [null, null], [null, null],
    ]);
    expect(offers.map((o) => o.excluded)).toEqual([null, null, "price_outlier", "cap"]);
  });

  it("keeps history, serves the newest scan and prunes scans past the retention window", async () => {
    await saveScan(A, ML, research("MLA-C1", "2026-05-01T00:00:00.000Z"));
    await saveScan(A, ML, research("MLA-C1", "2026-10-01T00:00:00.000Z"));
    const newest = research("MLA-C1", "2026-11-01T00:00:00.000Z");
    newest.points[1] = point("MLA102", 5002, { price: 1234 });
    await saveScan(A, ML, newest);
    expect((await loadLatestScan(A, ML, "MLA-C1"))?.points[1]?.price).toBe(1234);
    // May is > 90 days before November: pruned; October is kept as price history
    const scans = await db.marketScan.findMany({ where: { accountId: A }, orderBy: { fetchedAt: "asc" } });
    expect(scans.map((s) => s.fetchedAt.toISOString().slice(0, 7))).toEqual(["2026-10", "2026-11"]);
  });

  it("stores each seller nickname once, whoever asks", async () => {
    await saveSellerNicknames(ML, [[SELLER_OURS + 1, "uno"], [SELLER_OURS + 2, "dos"]]);
    await saveSellerNicknames(ML, [[SELLER_OURS + 2, "dos bis"]]);
    expect([...(await readSellerNicknames(ML, [SELLER_OURS + 1, SELLER_OURS + 2, SELLER_OURS + 3])).entries()]).toEqual([
      [SELLER_OURS + 1, "uno"], [SELLER_OURS + 2, "dos bis"],
    ]);
  });
});

describe("marketplace dimension", () => {
  const keyed = ["Listing", "ListingVariation", "Seller", "Shipment", "Order", "OrderItem", "Payment", "PaymentTax", "OrderPayment", "OrderPeriod", "ProductMapping", "MatchDecision", "MarketplaceConnection"];

  it("is part of the primary key of every table that stores ids a marketplace assigns", async () => {
    const rows = await db.$queryRaw<{ t: string; cols: string[] }[]>`
      SELECT c.relname AS t, array_agg(a.attname ORDER BY a.attnum) AS cols
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary AND c.relname = ANY(${keyed}::text[]) GROUP BY c.relname`;
    const without = keyed.filter((t) => !rows.find((r) => r.t === t)?.cols.includes("marketplace"));
    expect(without, "ids from different marketplaces could collide in these tables").toEqual([]);
  });

  it("is carried by the composite foreign keys between those tables", async () => {
    const rows = await db.$queryRaw<{ conname: string; cols: string[] }[]>`
      SELECT con.conname, array_agg(a.attname) AS cols
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
      WHERE con.contype = 'f' AND c.relname = ANY(${keyed}::text[]) AND array_length(con.conkey, 1) > 1 GROUP BY con.conname`;
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter((r) => !r.cols.includes("marketplace")).map((r) => r.conname)).toEqual([]);
  });

  it("tags sale lines: marketplace lines carry it, direct sales do not", async () => {
    await replaceSaleLines(A, ML, "2026-09", [line(), line({ channel: "VA", itemId: "", ean: "", time: "" })]);
    const rows = await db.saleLine.findMany({ where: { accountId: A }, orderBy: { lineNo: "asc" }, select: { channel: true, marketplace: true } });
    expect(rows).toEqual([{ channel: "marketplace", marketplace: "mercadolibre" }, { channel: "direct", marketplace: null }]);
  });
});
