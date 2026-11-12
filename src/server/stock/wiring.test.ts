/**
 * Production wiring of the stock services: nothing here injects a fake collaborator. Only the Mercado Libre edge
 * (item reads, the one write call, order fetching) is replaced, so every assertion is about the real ledger,
 * alerts, push engine, sales, returns and invoice services calling each other through their default dependencies.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_g2";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("~/server/ml/items-stock", () => ({
  getItemsStock: async (_a: string, ids: string[]) =>
    new Map(ids.map((id) => [id.toUpperCase(), {
      itemId: id.toUpperCase(), available_quantity: 5, status: "active", listing_type_id: "gold_special", variations: [], logistic_type: "xd_drop_off",
    }])),
}));
const mlWrite = vi.hoisted(() => vi.fn());
vi.mock("~/server/ml/stock-write", () => ({ setAvailableQuantity: mlWrite }));

import type { Order } from "~/lib/contracts";
import { db } from "~/server/db";
import { ensureAccount } from "~/server/store/bulk";
import { evaluateAlerts, resolveAlertById } from "./alerts";
import { dailyRates } from "./forecast";
import { createInvoiceService } from "./invoices";
import { appendMovement } from "./ledger";
import { createProductWithStock, getStockServices, linking } from "./linking";
import { getReturnsService } from "./returns";
import { createSales } from "./sales";

const A = "g2_wiring_a";
const CUTOVER = new Date("2026-10-01T00:00:00-03:00");

const orders = new Map<number, Order>();
const order = (id: number, quantity: number, dateCreated: string): Order => ({
  id, packId: null, status: "paid", dateCreated, shippingId: null, payments: [{ id: id * 10, status: "approved" }],
  items: [{ itemId: "MLA1", title: "Cámara", sellerSku: null, sellerCustomField: null, variationId: null, quantity, unitPrice: 100, saleFee: 10 }],
});
/** Only the ML edge is fake; every other dependency is the production default. */
const sales = createSales({
  ml: { fetchOrder: async (_a, id) => orders.get(id) ?? null, searchOrders: async () => [], shipmentStatus: async () => null },
});

const pushLog = () => db.mlPushLog.findMany({ where: { accountId: A }, orderBy: { id: "asc" } });
const alertsOf = (type: string, status?: string) =>
  db.stockAlert.findMany({ where: { accountId: A, type: type as never, ...(status ? { status: status as never } : {}) } });
const onHand = async (id: number) =>
  Number((await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_id: { accountId: A, id: BigInt(id) } } })).onHand);

async function product(name: string, stock: number, cost = 50, ean?: string): Promise<number> {
  const p = await db.inventoryProduct.create({ data: { accountId: A, name, ean } });
  const id = Number(p.id);
  if (stock > 0) {
    await appendMovement({ accountId: A, productId: id, type: "initial_count", quantity: stock, unitCost: cost, occurredAt: new Date("2026-09-30T00:00:00-03:00"), idempotencyKey: `init:${id}`, actor: "system" });
  }
  return id;
}

beforeEach(async () => {
  await db.account.deleteMany({ where: { id: A } });
  await ensureAccount(A);
  await db.inventorySettings.create({ data: { accountId: A, cutoverAt: CUTOVER } });
  orders.clear();
  mlWrite.mockReset();
});
afterAll(async () => {
  await db.account.deleteMany({ where: { id: A } });
  await db.$disconnect();
});

describe("link → cost review → pending sales (S5 ↔ S7 ↔ S4 ↔ S3 ↔ S1)", () => {
  it("linking a listing with parked sales raises the cost review; resolving it applies them, pushes (dry run) and re-evaluates", async () => {
    const p = await product("Cámara", 10);
    orders.set(1, order(1, 2, "2026-10-06T10:00:00.000-03:00"));
    orders.set(2, order(2, 1, "2026-10-07T10:00:00.000-03:00"));
    await sales.applyOrder(A, 1);
    await sales.applyOrder(A, 2);
    expect(await alertsOf("unmatched_sale", "open")).toHaveLength(1);
    expect(await onHand(p)).toBe(10); // parked, no stock written

    await linking.linkListing({ accountId: A, marketplace: "mercadolibre", itemId: "MLA1", variationId: null, components: [{ productId: p, quantity: 1 }] });
    const [review] = await alertsOf("link_cost_review", "open");
    expect(review).toMatchObject({ productId: BigInt(p), itemId: "MLA1" });
    expect(Number(review!.quantity)).toBe(2); // real S4 pending count
    expect(await onHand(p)).toBe(10); // still gated by the person

    expect(await resolveAlertById(A, Number(review!.id), "costo aceptado")).toBe(true);

    expect(await onHand(p)).toBe(7);
    const sale = await db.stockMovement.findMany({ where: { accountId: A, type: "sale" }, orderBy: { id: "asc" } });
    expect(sale.map((m) => m.refId)).toEqual(["1:0", "2:0"]);
    expect(await sales.pendingSalesCount(A, "MLA1", null)).toBe(0);
    expect(await alertsOf("unmatched_sale", "open")).toHaveLength(0); // S4 resolved it through the real S7
    const log = await pushLog();
    expect(log).toEqual([expect.objectContaining({ itemId: "MLA1", mode: "dry_run", result: "dry_run", requestedQty: 7, previousMlQty: 5, triggerType: "sale", triggerRef: "pending:MLA1" })]);
    expect(mlWrite).not.toHaveBeenCalled();
    expect((await dailyRates(A, [p])).get(p)).toBeGreaterThan(0);
    expect(getStockServices().dailyRates).toBe(dailyRates);
  });

  it("resolving the review twice applies nothing twice", async () => {
    const p = await product("Cámara", 10);
    orders.set(1, order(1, 2, "2026-10-06T10:00:00.000-03:00"));
    await sales.applyOrder(A, 1);
    await linking.linkListing({ accountId: A, marketplace: "mercadolibre", itemId: "MLA1", variationId: null, components: [{ productId: p, quantity: 1 }] });
    const [review] = await alertsOf("link_cost_review", "open");
    await resolveAlertById(A, Number(review!.id), "costo aceptado");
    expect(await resolveAlertById(A, Number(review!.id), "otra vez")).toBe(false);
    expect(await onHand(p)).toBe(8);
  });
});

describe("a sale, a restock and an invoice push and evaluate through the real services", () => {
  it("a linked paid order writes a dry-run push log row and raises out_of_stock when it empties the product", async () => {
    const p = await product("Cámara", 1);
    await linking.linkListing({ accountId: A, marketplace: "mercadolibre", itemId: "MLA1", variationId: null, components: [{ productId: p, quantity: 1 }] });
    orders.set(5, order(5, 1, "2026-10-08T10:00:00.000-03:00"));
    await sales.applyOrder(A, 5);
    expect(await pushLog()).toEqual([expect.objectContaining({ result: "dry_run", requestedQty: 0, triggerType: "sale", triggerRef: "5" })]);
    expect(await alertsOf("out_of_stock", "open")).toHaveLength(1);
  });

  it("restocking a return pushes the new quantity and clears the out_of_stock alert", async () => {
    const p = await product("Cámara", 1);
    await linking.linkListing({ accountId: A, marketplace: "mercadolibre", itemId: "MLA1", variationId: null, components: [{ productId: p, quantity: 1 }] });
    orders.set(6, order(6, 1, "2026-10-08T10:00:00.000-03:00"));
    await sales.applyOrder(A, 6);
    expect(await alertsOf("out_of_stock", "open")).toHaveLength(1);

    const returns = getReturnsService(); // production getter, no configure call
    const { record } = await returns.openReturn({ accountId: A, orderId: 6, lineNo: 0, productId: p, quantity: 1 });
    await returns.resolveReturn({ accountId: A, returnId: record.id, outcome: "restocked", confirmRestock: true });

    expect(await onHand(p)).toBe(1);
    const log = await pushLog();
    expect(log.at(-1)).toMatchObject({ result: "dry_run", requestedQty: 1, triggerType: "adjust", triggerRef: `return:${record.id}` });
    expect(await alertsOf("out_of_stock", "open")).toHaveLength(0);
    expect(mlWrite).not.toHaveBeenCalled();
  });

  it("confirming an invoice pushes a dry-run log row and re-evaluates alerts", async () => {
    const EAN = "0027242925489";
    const sample = readFileSync(path.join(__dirname, "../invoices/__fixtures__/sony-0225-00085935.pdf"));
    const EANS = [EAN, "0027242932425", "0027242928688", "0027242923638", "0027242931770", "0027242931817"];
    const ids: number[] = [];
    for (const [i, ean] of EANS.entries()) ids.push(await product(`Sony ${i + 1}`, 0, 0, ean));
    await linking.linkListing({ accountId: A, marketplace: "mercadolibre", itemId: "MLA9", variationId: null, components: [{ productId: ids[0]!, quantity: 1 }] });
    await evaluateAlerts(A);
    expect(await alertsOf("out_of_stock", "open")).toHaveLength(1);

    const svc = createInvoiceService(); // production defaults: real push + real evaluator
    const { invoiceId } = await svc.createDraft(A, { name: "inv.pdf", buffer: sample });
    await svc.confirm(A, invoiceId);

    expect(await onHand(ids[0]!)).toBeGreaterThan(0);
    const log = await pushLog();
    expect(log).toEqual([expect.objectContaining({ itemId: "MLA9", result: "dry_run", triggerType: "invoice" })]);
    expect(await alertsOf("out_of_stock", "open")).toHaveLength(0);
  });
});

describe("product creation goes through the real ledger", () => {
  it("initial stock becomes an initial_count movement", async () => {
    const p = await createProductWithStock(A, { name: "Nuevo", ean: "7790000000999", initialStock: 4, initialCost: 10 });
    const m = await db.stockMovement.findMany({ where: { accountId: A, productId: BigInt(p.id) } });
    expect(m).toEqual([expect.objectContaining({ type: "initial_count" })]);
    expect(await onHand(p.id)).toBe(4);
  });
});
