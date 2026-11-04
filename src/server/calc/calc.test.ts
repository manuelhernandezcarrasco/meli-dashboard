import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  BaseSchema,
  DashboardDataSchema,
  InputsSchema,
  LineSchema,
  OrderSchema,
  PaymentTaxesSchema,
  TotalsSchema,
  type BusinessConfig,
  type Inputs,
  type Order,
  type Totals,
} from "~/lib/contracts";
import {
  acum,
  buildComparison,
  buildLines,
  calibrateTaxPct,
  computeDashboard,
  dailySeries,
  unmatchedFrom,
} from "./index";

const load = (n: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/demo/${n}`, "utf-8"));

const orders = z.array(OrderSchema).parse(load("orders.json"));
const prevOrders = z.array(OrderSchema).parse(load("prev_orders.json"));
const base = BaseSchema.parse(load("base.json"));
const inputs = InputsSchema.parse(load("inputs.json"));
const taxes = z.record(PaymentTaxesSchema).parse(load("taxes.json"));
const ship = z.record(z.number()).parse(load("ship_costs.json"));
const gtins = z.record(z.record(z.string())).parse(load("gtins.json"));
const expLines = z.array(LineSchema).parse(load("lines.json"));
const expPrevLines = z.array(LineSchema).parse(load("prev_lines.json"));
const expDaily = z.array(TotalsSchema).parse(load("daily.json"));
const expPrevDaily = z.array(TotalsSchema).parse(load("prev_daily.json"));
const prevCierre = TotalsSchema.parse(load("prev_cierre.json"));
const meta = load("meta.json") as { y: number; m: number; taxPct: number; frozenNow: string };

const cfg: BusinessConfig = {
  refreshMinutes: 15,
  horaCierre: "23:55",
  mes: "",
  stockCriticoDias: 7,
  stockBajoDias: 15,
  reposicionDias: 30,
  impuestosMlPctEstimado: meta.taxPct,
  margenAsumido: { SONY: 0.08, "PLAY STATION": 0.08, "SIN MATCH": 0.3, OTRAS: 0.3 },
};

function expectClose(actual: unknown, expected: unknown, path = "") {
  if (typeof expected === "number") {
    expect(actual, path).toBeCloseTo(expected, 2);
  } else if (Array.isArray(expected)) {
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((e, i) => expectClose((actual as unknown[])[i], e, `${path}[${i}]`));
  } else if (expected && typeof expected === "object") {
    for (const [k, v] of Object.entries(expected))
      expectClose((actual as Record<string, unknown>)[k], v, `${path}.${k}`);
  } else {
    expect(actual, path).toEqual(expected);
  }
}

const emptyInputs: Inputs = { va: [], mapItem: {}, mapSku: {}, override: {}, ingresos: [] };
const baseSku = (ean: string, over: Partial<(typeof base)[string]> = {}) => ({
  ean, desc: `D${ean}`, modelo: "", cat: "SONY", cu: 100, stock: 0, mg: 0.08,
  costoMlPctPrev: null, udsPrev: 0, ...over,
});
const order = (over: Partial<Order> & { price?: number } = {}): Order => ({
  id: 1, packId: null, status: "paid", dateCreated: "2026-10-05T12:00:00.000-03:00",
  shippingId: null,
  items: [{ itemId: "mla1", title: "T", sellerSku: null, sellerCustomField: null, variationId: null,
    quantity: 1, unitPrice: over.price ?? 1000, saleFee: 100 }],
  payments: [], ...over,
});
const gt = { MLA1: { _item: "E1" } };

describe("fixtures", () => {
  it("buildLines equals lines.json and prev_lines.json", () => {
    expectClose(buildLines(orders, ship, gtins, base, inputs, cfg, meta.y, meta.m, taxes), expLines);
    expectClose(buildLines(prevOrders, ship, gtins, base, inputs, cfg, 2026, 9, taxes), expPrevLines);
  });
  it("dailySeries equals daily.json / prev_daily.json", () => {
    expectClose(dailySeries(expLines, meta.y, meta.m), expDaily);
    expectClose(dailySeries(expPrevLines, 2026, 9), expPrevDaily);
  });
  it("calibrateTaxPct reproduces the fixture pct", () => {
    const p0 = buildLines(prevOrders, ship, gtins, base, inputs, { ...cfg, impuestosMlPctEstimado: 0 }, 2026, 9);
    expect(calibrateTaxPct(p0, prevCierre)).toBeCloseTo(meta.taxPct, 4);
  });
  it("computeDashboard validates and matches the Python dashboard", () => {
    const py = load("dashboard.python.json") as { comp: { dia_corte: number }; rows: unknown[] };
    const out = computeDashboard({
      orders, prevOrders, shipCosts: ship, gtins, taxes, base, prevCierre, inputs,
      cfg: { ...cfg, impuestosMlPctEstimado: "auto" },
      y: meta.y, m: meta.m, now: new Date(meta.frozenNow), stockFn: () => [],
      cutDay: py.comp.dia_corte,
    });
    DashboardDataSchema.parse(out);
    expect(out.rows.length).toBe(py.rows.length);
    expect(out.updatedAt).toBe("20/10/2026 15:30");
    expect(out.monthLabel).toBe("Octubre 2026");
    expect(out.comp.cutDay).toBe(22);
    expect(out.unmatched.map((u) => u.itemId)).toEqual(["MLA1999999999"]);
    expect(out.comp.prevToday).toBeNull();
    expectClose(out.comp.prevDaily, expPrevDaily);
  });
});

describe("buildLines", () => {
  const run = (o: Order[], b = base, inp = emptyInputs, tx?: Record<string, { total: number; det: Record<string, number> }>, sc = {}) =>
    buildLines(o, sc, gt, b, inp, { ...cfg, impuestosMlPctEstimado: 0.03 }, 2026, 10, tx);

  it("splits a shared shipment by revenue and ignores cancelled orders", () => {
    const a = order({ id: 1, shippingId: 7, price: 3000 });
    const b = order({ id: 2, shippingId: 7, price: 1000 });
    const c = order({ id: 3, shippingId: 7, price: 9000, status: "cancelled" });
    const l = run([a, b, c], { E1: baseSku("E1") }, emptyInputs, undefined, { "7": 400 });
    expect(l.map((x) => x.envio)).toEqual([300, 100]);
  });
  it("uses Mercado Pago taxes when approved, else the estimate", () => {
    const withPay = order({ payments: [{ id: 5, status: "approved" }] });
    const [mp] = run([withPay], { E1: baseSku("E1") }, emptyInputs, { "5": { total: 80, det: { IIBB: 50, Otro: 30 } } });
    expect(mp!.taxSource).toBe("Mercado Pago");
    expect(mp!.impEst).toBe(80);
    expect(mp!.taxDetail).toBe("IIBB 50; Otro 30");
    const [est] = run([order()], { E1: baseSku("E1") });
    expect(est!.taxSource).toBe("Estimado 3.0%");
    expect(est!.impEst).toBeCloseTo(30);
  });
  it("override beats base", () => {
    const [l] = run([order()], { E1: baseSku("E1") }, { ...emptyInputs, override: { E1: { cu: 55, desc: "x", cat: null } } });
    expect(l!.cu).toBe(55);
    expect(l!.costSource).toBe("Override");
  });
  it("unknown EAN is SIN MATCH; assumed margin when cu is 0", () => {
    const [l] = run([order()], {});
    expect(l!.cat).toBe("SIN MATCH");
    expect(l!.costSource).toBe("Sin match – asumido 30%");
    const [a] = run([order()], { E1: baseSku("E1", { cu: 0 }) });
    expect(a!.costSource).toBe("Asumido 8%");
    expect(a!.cu).toBeCloseTo(920);
  });
  it("matches SKU equal to an EAN in base", () => {
    const o = order();
    o.items[0]!.sellerSku = "00123";
    const [l] = buildLines([o], {}, {}, { "123": baseSku("123") }, emptyInputs, cfg, 2026, 10);
    expect(l!.matchVia).toBe("SKU=EAN");
    expect(l!.ean).toBe("123");
  });
  it("direct sales: only the same month, channel VA", () => {
    const va = (date: string) => ({ date, cliente: "C", ean: "E1", desc: "d", qty: 2, pu: 10 });
    const l = run([], { E1: baseSku("E1") }, { ...emptyInputs, va: [va("2026-10-03"), va("2026-09-30")] });
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ channel: "VA", matchVia: "Carga manual", time: "", venta: 20, costoMl: 0 });
  });
});

describe("unmatchedFrom", () => {
  it("groups by item, sorts by venta desc", () => {
    const l = buildLines([order({ id: 1 }), order({ id: 2, price: 5000 })], {}, {}, {}, emptyInputs, cfg, 2026, 10);
    expect(unmatchedFrom(l)).toHaveLength(1);
    expect(unmatchedFrom(l)[0]!.venta).toBe(6000);
  });
});

describe("buildComparison", () => {
  const prev = (day: number, time: string, price: number) =>
    order({ id: day * 100 + price, dateCreated: `2026-09-${String(day).padStart(2, "0")}T${time}:00.000-03:00`, price });
  const pl = buildLines(
    [prev(15, "10:00", 1000), prev(15, "16:00", 2000), prev(14, "20:00", 500)],
    {}, gt, { E1: baseSku("E1") }, emptyInputs, { ...cfg, impuestosMlPctEstimado: 0 }, 2026, 9,
  );
  const args = { lines: [], prevLines: pl, prevCierre: prevCierre as Totals, y: 2026, m: 10 };

  it("counts previous-month lines of the cut day only up to the current time", () => {
    const c = buildComparison({ ...args, now: new Date("2026-10-15T15:30:00-03:00"), cutDay: 15 });
    expect(c.prevToday?.venta).toBe(1000);
    expect(c.cutTime).toBe("15:30");
    expect(c.prevAccumAtCut.venta).toBe(1500);
  });
  it("uses the full day for a past month", () => {
    const c = buildComparison({ ...args, now: new Date("2026-12-01T10:00:00-03:00"), cutDay: 15 });
    expect(c.prevToday).toBeNull();
    expect(c.cutTime).toBeNull();
    expect(c.prevAccumAtCut.venta).toBe(3500);
  });
  it("falls back to acum(prevDaily) when prevCierre is empty", () => {
    const empty = { ...prevCierre, venta: 0, cogs: 0 };
    const c = buildComparison({ ...args, prevCierre: empty, now: new Date("2026-12-01T10:00:00-03:00"), cutDay: 15 });
    expect(c.prevCierre.venta).toBe(3500);
  });
});

describe("acum", () => {
  it("sums the first n days", () => {
    expect(acum(expDaily, 2).venta).toBeCloseTo(expDaily[0]!.venta + expDaily[1]!.venta);
  });
});

describe("buildLines fuzzy title match", () => {
  it("links an unmapped listing to a similar P&L product and proposes uncertain ones", async () => {
    const { createMatcher } = await import("~/lib/product-match");
    const { loadBusinessConfig } = await import("~/server/config");
    const mk = (ean: string, desc: string, cat: string) => ({
      ean, desc, modelo: "", cat, cu: 100, stock: 0, mg: 0.15, costoMlPctPrev: null, udsPrev: 0,
    });
    const base = { "1": mk("1", "Xbox Control Blue", "XBOX") };
    const order = (id: string, title: string) => ({
      id: Number(id), packId: null, status: "paid", dateCreated: "2026-10-05T12:00:00-03:00",
      shippingId: null, payments: [],
      items: [{ itemId: `MLA${id}`, title, sellerSku: null, sellerCustomField: null,
        variationId: null, quantity: 1, unitPrice: 1000, saleFee: 100 }],
    });
    const lines = buildLines(
      [order("1", "Controlador Inalámbrico Joystick Xbox Serie X|s Shock Blue"), order("2", "Control Xbox Inalámbrico")],
      {}, {}, base, { va: [], mapItem: {}, mapSku: {}, override: {}, ingresos: [] },
      { ...loadBusinessConfig(), impuestosMlPctEstimado: 0 }, 2026, 10, undefined, createMatcher(base),
    );
    expect(lines[0]).toMatchObject({ ean: "1", cat: "XBOX", cu: 100, matchVia: "Similitud de título" });
    expect(lines[1]).toMatchObject({ ean: "", cat: "SIN MATCH", suggestEan: "1" });
  });
});
