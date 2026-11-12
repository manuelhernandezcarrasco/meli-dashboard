import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s6";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));

import type { Base, Order } from "~/lib/contracts";
import { buildLines } from "~/server/calc";
import { db } from "~/server/db";
import { ensureAccount } from "~/server/store/bulk";
import { loadLedgerCosts } from "~/server/store/stockCutover";
import { saveUpload } from "~/server/workbooks/store";
import { appendMovement } from "./ledger";
import { createLinking } from "./linking";
import { applyExcelEvents, CutoverError, runCutover, type CutoverDeps } from "./cutover";

const A = "s6_user_a";
const B = "s6_user_b";
const ML = "mercadolibre" as const;
const CUT = new Date("2026-10-01T03:00:00.000Z");

const linking = createLinking({
  alerts: { raiseAlert: async () => ({ alertId: 1, created: true }), resolveAlert: async () => undefined },
  pendingSales: async () => 0,
});
const deps: CutoverDeps = {
  appendMovement,
  autoLink: (a) => linking.autoLink(a),
  unlinkedCount: async (a) => (await linking.unlinkedListings(a)).length,
};

const product = (accountId: string, ean: string, over: Partial<{ unitCost: number; stockFinal: number; description: string }> = {}) => ({
  accountId, ean, description: over.description ?? `Prod ${ean}`, model: "M", category: "SONY",
  unitCost: over.unitCost ?? 100, stockFinal: over.stockFinal ?? 5, assumedMargin: 0.08, prevMlCostPct: null, prevUnits: 0, position: Number(ean.slice(-2)),
});

async function seedSnapshot(accountId = A) {
  await ensureAccount(accountId);
  await db.product.createMany({
    data: [
      product(accountId, "7790000000011", { unitCost: 100, stockFinal: 5 }),
      product(accountId, "7790000000028", { unitCost: 250.5, stockFinal: 0 }),
      product(accountId, "7790000000035", { unitCost: 0, stockFinal: 3 }),
    ],
  });
}

const listing = (itemId: string, gtin: string | null) =>
  db.listing.create({ data: { accountId: A, marketplace: ML, itemId, title: `T ${itemId}`, gtin } });

beforeEach(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
});
afterAll(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await db.$disconnect();
});

describe("runCutover", () => {
  it("imports products, opening stock and cost, sets the date and links exact GTINs", async () => {
    await seedSnapshot();
    await listing("MLA1", "7790000000011");
    await listing("MLA2", "7790000000999");
    const r = await runCutover(A, { cutoverAt: CUT }, deps);
    expect(r).toMatchObject({ productsCreated: 3, productsExisting: 0, listingsLinked: 1, listingsUnlinked: 1, alreadyDone: false });

    const p = await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_ean: { accountId: A, ean: "7790000000011" } } });
    expect(p).toMatchObject({ name: "Prod 7790000000011", model: "M", category: "SONY" });
    expect(Number(p.onHand)).toBe(5);
    expect(Number(p.unitCost)).toBe(100);
    const mv = await db.stockMovement.findMany({ where: { accountId: A, productId: p.id } });
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ type: "initial_count", occurredAt: CUT });
    const ce = await db.productCostEntry.findMany({ where: { accountId: A, productId: p.id } });
    expect(ce).toHaveLength(1);
    expect(ce[0]).toMatchObject({ reason: "initial", effectiveFrom: CUT });
    expect(Number(ce[0]!.unitCost)).toBe(100);

    // empty opening stock still creates the product and its cost
    const z = await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_ean: { accountId: A, ean: "7790000000028" } } });
    expect(Number(z.onHand)).toBe(0);
    expect(Number(z.unitCost)).toBe(250.5);

    expect((await db.inventorySettings.findUniqueOrThrow({ where: { accountId: A } })).cutoverAt).toEqual(CUT);
    expect(await db.listingLink.count({ where: { accountId: A } })).toBe(1);
  });

  it("is idempotent; a second run with another date is refused", async () => {
    await seedSnapshot();
    await runCutover(A, { cutoverAt: CUT }, deps);
    const r = await runCutover(A, { cutoverAt: CUT }, deps);
    expect(r).toMatchObject({ productsCreated: 0, productsExisting: 3, alreadyDone: true });
    expect(await db.stockMovement.count({ where: { accountId: A } })).toBe(4); // the zero-stock product with a cost needs a +1/-1 pair

    await expect(runCutover(A, { cutoverAt: new Date("2026-11-01T03:00:00Z") }, deps)).rejects.toMatchObject({ code: "CUTOVER_DATE_MISMATCH" });
    expect((await db.inventorySettings.findUniqueOrThrow({ where: { accountId: A } })).cutoverAt).toEqual(CUT);
  });

  it("needs an uploaded P&L snapshot", async () => {
    await ensureAccount(A);
    await expect(runCutover(A, { cutoverAt: CUT }, deps)).rejects.toBeInstanceOf(CutoverError);
    expect(await db.inventorySettings.findUnique({ where: { accountId: A } })).toBeNull();
  });

  it("does not touch other accounts", async () => {
    await seedSnapshot();
    await seedSnapshot(B);
    await runCutover(A, { cutoverAt: CUT }, deps);
    expect(await db.inventoryProduct.count({ where: { accountId: B } })).toBe(0);
  });
});

describe("Excel upload after the cutover", () => {
  const demo = path.resolve(import.meta.dirname, "../../../demo");
  const pnl = fs.readFileSync(path.join(demo, "PnL_MercadoLibre_Septiembre2026_DEMO.xlsx"));

  it("writes excel_reset with cost and stock plus the log text, and creates new EANs", async () => {
    await seedSnapshot();
    await runCutover(A, { cutoverAt: CUT }, deps);
    const ean = "7790000000011";
    const up = new Date("2026-10-20T15:00:00.000Z");
    const r = await applyExcelEvents(
      A,
      [
        { ean, description: "x", model: "", category: "", unitCost: 130, stockFinal: 8 },
        { ean: "7790000000042", description: "Nuevo", model: "", category: "XBOX", unitCost: 70, stockFinal: 2 },
        { ean: "7790000000035", description: "sin costo", model: "", category: "", unitCost: 0, stockFinal: 1 },
      ],
      { fileName: "cierre.xlsx", uploadedAt: up }, deps,
    );
    expect(r).toEqual({ reset: 2, created: 1 });

    const p = await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_ean: { accountId: A, ean } } });
    expect(Number(p.onHand)).toBe(8);
    expect(Number(p.unitCost)).toBe(130);
    const reset = await db.stockMovement.findFirstOrThrow({ where: { accountId: A, productId: p.id, type: "excel_reset" } });
    expect(Number(reset.quantity)).toBe(3);
    expect(reset.occurredAt).toEqual(up);
    expect(reset.reason).toBe("Excel cierre.xlsx 2026-10-20: costo y stock");
    expect(await db.productCostEntry.count({ where: { accountId: A, productId: p.id, reason: "excel" } })).toBe(1);

    // a cost of 0 in the workbook keeps the current cost (this product had none: stays 0), stock is still set
    const nc = await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_ean: { accountId: A, ean: "7790000000035" } } });
    expect(Number(nc.onHand)).toBe(1);

    const created = await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_ean: { accountId: A, ean: "7790000000042" } } });
    expect(Number(created.onHand)).toBe(2);
    expect(Number(created.unitCost)).toBe(70);

    // replay of the same upload does nothing
    await applyExcelEvents(A, [{ ean, description: "x", model: "", category: "", unitCost: 130, stockFinal: 8 }], { fileName: "cierre.xlsx", uploadedAt: up }, deps);
    expect(await db.stockMovement.count({ where: { accountId: A, productId: p.id, type: "excel_reset" } })).toBe(1);
  });

  it("is a no-op before the cutover", async () => {
    await ensureAccount(A);
    expect(await applyExcelEvents(A, [{ ean: "1", description: "", model: "", category: "", unitCost: 1, stockFinal: 1 }], { fileName: "f", uploadedAt: new Date() }, deps)).toBeNull();
    expect(await db.inventoryProduct.count({ where: { accountId: A } })).toBe(0);
  });

  it("saveUpload hooks the pnl file in and warns on the inputs file", async () => {
    await saveUpload(A, "pnl", "uno.xlsx", pnl); // before the cutover: legacy only
    expect(await db.stockMovement.count({ where: { accountId: A } })).toBe(0);
    await runCutover(A, { cutoverAt: CUT }, { ...deps });
    const before = await db.stockMovement.count({ where: { accountId: A } });
    expect(before).toBeGreaterThan(0);
    await saveUpload(A, "pnl", "dos.xlsx", pnl);
    expect(await db.stockMovement.count({ where: { accountId: A, type: "excel_reset" } })).toBeGreaterThan(0);
    expect((await db.product.count({ where: { accountId: A } }))).toBeGreaterThan(0); // legacy still written

    const va = fs.readFileSync(path.join(demo, "Ventas_Directas_DEMO.xlsx"));
    const s = await saveUpload(A, "inputs", "va.xlsx", va);
    expect(s.notice).toMatch(/Ingresos Stock/);
    expect(await db.stockMovement.count({ where: { accountId: A, type: "purchase_in" } })).toBe(0);
  });
});

describe("ledger COGS", () => {
  const EAN = "7790000000011";
  const base: Base = {};
  const inputs = { va: [], mapItem: {}, mapSku: {}, override: { [EAN]: { cu: 55, desc: "o", cat: null } }, ingresos: [] };
  const cfg = {
    refreshMinutes: 15, horaCierre: "23:55", mes: "", stockCriticoDias: 7, stockBajoDias: 15, reposicionDias: 30,
    impuestosMlPctEstimado: 0, margenAsumido: { "SIN MATCH": 0.3, OTRAS: 0.3 },
  };
  const order = (id: number, dateCreated: string): Order => ({
    id, packId: null, status: "paid", dateCreated, shippingId: null, payments: [],
    items: [{ itemId: "mla1", title: "T", sellerSku: null, sellerCustomField: null, variationId: null, quantity: 1, unitPrice: 1000, saleFee: 100 }],
  });
  const gt = { MLA1: { _item: EAN } };

  async function setup() {
    await seedSnapshot();
    await runCutover(A, { cutoverAt: CUT }, deps); // cost 100 from CUT
    const p = await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_ean: { accountId: A, ean: EAN } } });
    // an invoice at 2026-10-10 brings 5 units at 200 -> weighted cost 150
    await appendMovement({
      accountId: A, productId: Number(p.id), type: "purchase_in", quantity: 5, unitCost: 200,
      occurredAt: new Date("2026-10-10T15:00:00Z"), idempotencyKey: "inv-1", actor: "user",
    });
    return Number(p.id);
  }
  const lines = async (orders: Order[]) => buildLines(orders, {}, gt, base, inputs, cfg, 2026, 10, undefined, undefined, await loadLedgerCosts(A));

  it("uses the cost in effect at the sale instant; before the cutover keeps the legacy chain", async () => {
    await setup();
    const ls = await lines([
      order(1, "2026-09-20T12:00:00.000-03:00"), // before cutover: Override
      order(2, "2026-10-05T12:00:00.000-03:00"), // after cutover, before invoice
      order(3, "2026-10-15T12:00:00.000-03:00"), // after the invoice's cost change
    ]);
    expect(ls.map((l) => [l.cu, l.costSource])).toEqual([
      [55, "Override"],
      [100, "Ledger (costo ponderado)"],
      [150, "Ledger (costo ponderado)"],
    ]);
  });

  it("a ledger product without cost falls back to the legacy chain; no ledger = unchanged", async () => {
    await setup();
    const orders = [order(2, "2026-10-05T12:00:00.000-03:00")];
    const noCost = await buildLines(orders, {}, { MLA1: { _item: "7790000000035" } }, base, { ...inputs, override: {} }, cfg, 2026, 10, undefined, undefined, await loadLedgerCosts(A));
    expect(noCost[0]!.costSource).toMatch(/^Sin match/);
    const legacy = buildLines(orders, {}, gt, base, inputs, cfg, 2026, 10);
    expect(legacy[0]).toMatchObject({ cu: 55, costSource: "Override" });
  });

  it("rebuilding twice, and after later cost changes, never changes a frozen cost", async () => {
    const pid = await setup();
    const orders = [order(2, "2026-10-05T12:00:00.000-03:00"), order(3, "2026-10-15T12:00:00.000-03:00")];
    const first = await lines(orders);
    expect((await lines(orders)).map((l) => l.cu)).toEqual(first.map((l) => l.cu));
    await appendMovement({
      accountId: A, productId: pid, type: "purchase_in", quantity: 10, unitCost: 900,
      occurredAt: new Date("2026-10-25T15:00:00Z"), idempotencyKey: "inv-2", actor: "user",
    });
    expect((await lines(orders)).map((l) => l.cu)).toEqual(first.map((l) => l.cu));
    expect((await lines([order(4, "2026-10-26T12:00:00.000-03:00")]))[0]!.cu).toBeGreaterThan(150);
  });

  it("no cutover -> no ledger lookup", async () => {
    await ensureAccount(A);
    expect(await loadLedgerCosts(A)).toBeUndefined();
  });
});
