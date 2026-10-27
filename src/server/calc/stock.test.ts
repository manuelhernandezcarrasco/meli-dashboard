import { describe, expect, it } from "vitest";
import type { Base, BusinessConfig, Inputs, Line, StockItem } from "~/lib/contracts";
import base from "../../../tests/fixtures/demo/base.json";
import inputs from "../../../tests/fixtures/demo/inputs.json";
import lines from "../../../tests/fixtures/demo/lines.json";
import expected from "../../../tests/fixtures/demo/stock.json";
import { computeStock, toStockRow } from "./stock";

const cfg: BusinessConfig = {
  refreshMinutes: 15,
  horaCierre: "23:55",
  mes: "",
  stockCriticoDias: 7,
  stockBajoDias: 15,
  reposicionDias: 30,
  impuestosMlPctEstimado: "auto",
  margenAsumido: {},
};

const sku = (o: Partial<Base[string]> = {}): Base[string] => ({
  ean: "E1", desc: "Prod", modelo: "", cat: "CAT", cu: 100, stock: 0, mg: 0.1,
  costoMlPctPrev: null, udsPrev: 0, ...o,
});
const line = (qty: number, date = "2026-10-05", ean = "E1"): Line =>
  ({ date, ean, qty }) as Line;
const noInputs: Inputs = { va: [], mapItem: {}, mapSku: {}, override: {}, ingresos: [] };
const run = (b: Base, l: Line[], i: Inputs = noInputs, cutDay = 10) =>
  computeStock(b, l, i, cfg, 2026, 10, cutDay, 30);

describe("computeStock fixture", () => {
  it("matches the Python output", () => {
    const got = computeStock(
      base as Base, lines as Line[], inputs as Inputs, cfg, 2026, 10, 20, 30,
    );
    expect(got.map((s) => s.ean)).toEqual(expected.map((s) => s.ean));
    got.forEach((g, i) => {
      const e = expected[i] as StockItem;
      for (const k of ["initial", "inflow", "sold", "remaining", "rate", "reorder", "cu"] as const) {
        expect(g[k]).toBeCloseTo(e[k], 6);
      }
      if (e.coverage === null) expect(g.coverage).toBeNull();
      else expect(g.coverage).toBeCloseTo(e.coverage, 6);
      expect(g.desc).toBe(e.desc);
      expect(g.cat).toBe(e.cat);
      expect(g.rateSource).toBe(e.rateSource);
      expect(g.breakDate).toBe(e.breakDate);
      expect(g.state).toBe(e.state);
    });
  });
});

describe("computeStock hand cases", () => {
  it("sold more than stock -> Vendido sin stock", () => {
    const [s] = run({ E1: sku({ stock: 2 }) }, [line(5)]);
    expect(s!.state).toBe("Vendido sin stock");
    expect(s!.remaining).toBe(-3);
    expect(s!.coverage).toBe(0);
    expect(s!.breakDate).toBeNull();
  });

  it("stock 0 -> Agotado", () => {
    const [s] = run({ E1: sku({ stock: 5 }) }, [line(5)]);
    expect(s!.state).toBe("Agotado");
  });

  it("coverage thresholds", () => {
    // cutDay 10, sold 10 -> rate 1/day, so remaining == coverage in days
    const st = (rem: number) => run({ E1: sku({ stock: 10 + rem }) }, [line(10)])[0]!;
    expect(st(6.9).state).toBe("Crítico");
    expect(st(7).state).toBe("Bajo");
    expect(st(14.9).state).toBe("Bajo");
    expect(st(15).state).toBe("OK");
  });

  it("break date is cutDate + floor(coverage) days", () => {
    const [s] = run({ E1: sku({ stock: 10 + 12.5 }) }, [line(10)]);
    expect(s!.breakDate).toBe("2026-10-22");
  });

  it("no sales this month uses the previous-month rate", () => {
    const [s] = run({ E1: sku({ stock: 30, udsPrev: 60 }) }, []);
    expect(s!.rateSource).toBe("mes anterior");
    expect(s!.rate).toBe(2);
    expect(s!.coverage).toBe(15);
  });

  it("no rate and no stock is skipped", () => {
    expect(run({ E1: sku({ stock: 0 }) }, [])).toEqual([]);
  });

  it("ignores sales and inflows after the cut day or outside the month", () => {
    const i: Inputs = {
      ...noInputs,
      ingresos: [
        { date: "2026-10-10", ean: "E1", qty: 4 },
        { date: "2026-10-11", ean: "E1", qty: 100 },
        { date: "2026-09-05", ean: "E1", qty: 100 },
      ],
    };
    const [s] = run(
      { E1: sku({ stock: 10 }) },
      [line(2), line(50, "2026-10-11"), line(50, "2026-09-05")],
      i,
    );
    expect(s!.inflow).toBe(4);
    expect(s!.sold).toBe(2);
    expect(s!.remaining).toBe(12);
  });

  it("rounds like Python (banker's) for reorder", () => {
    // rate 0.05 * 30 = 1.5 -> 2 ; rate 0.25*10=2.5 handled via remaining 0
    const [a] = run({ E1: sku({ stock: 100 }) }, [line(0.5)]);
    expect(a!.reorder).toBe(0);
    const [b] = run({ E1: sku({ stock: 0.5 }) }, [line(0.25)], noInputs, 10);
    // rate 0.025*30=0.75, remaining .25 -> 0.5 -> round half even = 0
    expect(b!.reorder).toBe(0);
  });

  it("sorts by state then urgency", () => {
    const b: Base = {
      A: sku({ ean: "A", stock: 10 + 20 }), // OK cov 20 (rate1)
      B: sku({ ean: "B", stock: 10 + 3 }), // Crítico cov 3
      C: sku({ ean: "C", stock: 5 }), // Vendido sin stock rem -5
      D: sku({ ean: "D", stock: 10 + 1 }), // Crítico cov 1
      E: sku({ ean: "E", stock: 10 }), // Agotado
    };
    const l = ["A", "B", "C", "D", "E"].map((e) => line(10, "2026-10-05", e));
    expect(run(b, l).map((s) => s.ean)).toEqual(["C", "E", "D", "B", "A"]);
  });
});

describe("toStockRow", () => {
  it("drops cu and truncates desc to 60 chars", () => {
    const [s] = run({ E1: sku({ stock: 20, desc: "x".repeat(80) }) }, [line(1)]);
    const row = toStockRow(s!);
    expect(row.desc).toHaveLength(60);
    expect(row).not.toHaveProperty("cu");
    expect(row.ean).toBe("E1");
  });
});
