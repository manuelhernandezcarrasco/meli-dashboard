import { describe, expect, it } from "vitest";
import { DashboardDataSchema } from "~/lib/contracts";
import sample from "~/lib/sample-dashboard.json";
import {
  accumSeries, agg, alerts, missingCosts, categories, categoryTable, computeDashboard, cutoffDay,
  filterRows, pct, short, ars, stockCounts, stockRows, topProducts, upToDay, waterfall,
  STOCK_STATES, type StockState,
} from "./dashboard-math";

const data = DashboardDataSchema.parse(sample);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("formatting", () => {
  it("formats es-AR", () => {
    expect(ars(1234567)).toBe("$ 1.234.567");
    expect(ars(-1500)).toBe("-$ 1.500");
    expect(short(1_250_000)).toBe("$ 1,3M");
    expect(short(45_000)).toBe("$ 45k");
    expect(pct(0.1234)).toBe("12,3%");
    expect(pct(null)).toBe("–");
  });
});

describe("dashboard math", () => {
  const corte = cutoffDay(data);

  it("month totals equal the sums of rows", () => {
    const d = computeDashboard(data, "all", "all");
    const rows = upToDay(data.rows, corte);
    expect(d.mes.venta).toBeCloseTo(sum(rows.map((r) => r.sale)), 6);
    expect(d.mes.costoMl).toBeCloseTo(sum(rows.map((r) => r.costML)), 6);
    expect(d.mes.cogs).toBeCloseTo(sum(rows.map((r) => r.cogs)), 6);
    expect(d.mes.qty).toBeCloseTo(sum(rows.map((r) => r.qty)), 6);
  });

  it("ML + VA = Todos", () => {
    const all = agg(filterRows(data, "all", "all"));
    const ml = agg(filterRows(data, "ML", "all"));
    const va = agg(filterRows(data, "VA", "all"));
    expect(ml.venta + va.venta).toBeCloseTo(all.venta, 6);
    expect(ml.cogs + va.cogs).toBeCloseTo(all.cogs, 6);
    expect(ml.mb + va.mb).toBeCloseTo(all.mb, 6);
  });

  it("category filter keeps only that category", () => {
    const cat = categories(data)[0]!;
    const rows = filterRows(data, "all", cat);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.cat === cat)).toBe(true);
    const total = sum(categories(data).map((c) => agg(filterRows(data, "all", c)).venta));
    expect(total).toBeCloseTo(agg(data.rows).venta, 6);
  });

  it("top products are ordered by venta", () => {
    const top = topProducts(data.rows, corte);
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThanOrEqual(15);
    for (let i = 1; i < top.length; i++) {
      expect(top[i - 1]!.t.venta).toBeGreaterThanOrEqual(top[i]!.t.venta);
    }
  });

  it("category table total matches month and is sorted", () => {
    const { rows, total } = categoryTable(data.rows, corte);
    expect(sum(rows.map((r) => r.t.venta))).toBeCloseTo(total.venta, 6);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.t.venta).toBeGreaterThanOrEqual(rows[i]!.t.venta);
    }
  });

  it("waterfall steps add up: venta - costoML - cogs = margen", () => {
    const { mes } = computeDashboard(data, "all", "all");
    const wf = waterfall(mes);
    expect(wf).toHaveLength(5);
    expect(wf[0]!.amount + wf[1]!.amount).toBeCloseTo(wf[2]!.amount, 6);
    expect(wf[2]!.amount + wf[3]!.amount).toBeCloseTo(wf[4]!.amount, 6);
    expect(mes.venta - mes.costoMl - mes.cogs).toBeCloseTo(mes.mb, 6);
  });

  it("accumulated series ends at month sales and previous matches prevDaily sum", () => {
    const { mes } = computeDashboard(data, "all", "all");
    const acc = accumSeries(data, data.rows, corte, true);
    expect(acc).toHaveLength(data.comp.nDays);
    expect(acc[corte - 1]!.current).toBeCloseTo(mes.venta, 6);
    expect(acc[corte]?.current ?? null).toBeNull();
    const last = acc[data.comp.prevDaily.length - 1]!.prev;
    expect(last).toBeCloseTo(sum(data.comp.prevDaily.map((d) => d.venta)), 6);
    expect(accumSeries(data, data.rows, corte, false).every((p) => p.prev === null)).toBe(true);
  });

  it("previous comparison at the cutoff uses prevAccumAtCut when live, else prevDaily sum", () => {
    const d = computeDashboard(data, "all", "all");
    const venta = d.kMes.cards[0]!;
    const prevVenta = d.mes.venta / (1 + venta.delta!);
    const expected = d.sameMonth && data.comp.prevToday && corte === data.comp.cutDay
      ? data.comp.prevAccumAtCut.venta
      : sum(data.comp.prevDaily.slice(0, corte).map((x) => x.venta));
    expect(prevVenta).toBeCloseTo(expected, 4);
  });

  it("no comparison when a filter is active", () => {
    const d = computeDashboard(data, "ML", "all");
    expect(d.kMes.cards.every((c) => c.delta === null)).toBe(true);
    expect(d.projectionDelta).toBeNull();
  });

  it("stock counts and state filter", () => {
    const cnt = stockCounts(data.stock, "all");
    expect(sum(Object.values(cnt))).toBe(data.stock.length);
    const sel = new Set<StockState>(["Crítico"]);
    expect(stockRows(data.stock, "all", sel).every((s) => s.state === "Crítico")).toBe(true);
    expect(stockRows(data.stock, "all", new Set(STOCK_STATES))).toHaveLength(data.stock.length);
  });

  it("alerts list assumed lines and unmatched", () => {
    const a = alerts(data, { assumed: 3 });
    expect(a[0]).toContain("3 líneas con costo asumido");
    expect(a.some((x) => x.includes("sin EAN"))).toBe(true);
    expect(alerts({ ...data, unmatched: [] }, { assumed: 0 })).toEqual([]);
  });

  it("missingCosts groups assumed lines per product, biggest sale first", () => {
    const base = { cat: "c", qty: 1 };
    const r = missingCosts([
      { ...base, ean: "1", desc: "A", sale: 10, assumed: true },
      { ...base, ean: "1", desc: "A", sale: 5, assumed: true },
      { ...base, ean: "2", desc: "B", sale: 50, assumed: true },
      { ...base, ean: "3", desc: "C", sale: 99, assumed: false },
    ]);
    expect(r.map((x) => x.ean)).toEqual(["2", "1"]);
    expect(r[1]).toMatchObject({ lines: 2, qty: 2, venta: 15 });
  });
});
