import { describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));

import type { Base, BusinessConfig, Inputs, Line } from "~/lib/contracts";
import { computeStock } from "~/server/calc/stock";
import { computeCoverage } from "./forecast";

const cfg: BusinessConfig = {
  refreshMinutes: 15, horaCierre: "23:55", mes: "", stockCriticoDias: 7, stockBajoDias: 15,
  reposicionDias: 30, impuestosMlPctEstimado: "auto", margenAsumido: {},
};
const noInputs: Inputs = { va: [], mapItem: {}, mapSku: {}, override: {}, ingresos: [] };

/** Runs the legacy computeStock and the new forecast on equivalent inputs. */
function both(opts: { initial: number; inflow: number; sold: number; udsPrev: number; cutDay: number }) {
  const base: Base = {
    E1: { ean: "E1", desc: "P", modelo: "", cat: "C", cu: 1, stock: opts.initial, mg: 0.1, costoMlPctPrev: null, udsPrev: opts.udsPrev },
  };
  const lines = opts.sold ? ([{ date: "2026-10-02", ean: "E1", qty: opts.sold }] as Line[]) : [];
  const inputs: Inputs = { ...noInputs, ingresos: opts.inflow ? [{ date: "2026-10-01", ean: "E1", qty: opts.inflow }] : [] } as Inputs;
  const [old] = computeStock(base, lines, inputs, cfg, 2026, 10, opts.cutDay, 30);
  const onHand = opts.initial + opts.inflow - opts.sold;
  const neu = computeCoverage({
    onHand, soldCur: opts.sold, soldPrev: opts.udsPrev, dayOfMonth: opts.cutDay, prevMonthDays: 30,
    today: `2026-10-${String(opts.cutDay).padStart(2, "0")}`, reposicionDias: cfg.reposicionDias,
  });
  return { old, neu };
}

describe("computeCoverage parity with computeStock", () => {
  const cases = [
    { name: "sells this month", initial: 50, inflow: 10, sold: 20, udsPrev: 5, cutDay: 10 },
    { name: "falls back to previous month", initial: 40, inflow: 0, sold: 0, udsPrev: 30, cutDay: 10 },
    { name: "no sales at all, stock left", initial: 9, inflow: 0, sold: 0, udsPrev: 0, cutDay: 10 },
    { name: "sold out", initial: 5, inflow: 0, sold: 5, udsPrev: 0, cutDay: 12 },
    { name: "oversold", initial: 2, inflow: 0, sold: 6, udsPrev: 0, cutDay: 12 },
    { name: "fractional rate", initial: 100, inflow: 0, sold: 7, udsPrev: 0, cutDay: 13 },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const { old, neu } = both(c);
      if (!old) return expect(neu.rate).toBe(0); // computeStock skips rate 0 with nothing left
      expect(neu.rate).toBe(old.rate);
      expect(neu.rateSource).toBe(old.rateSource);
      expect(neu.coverageDays).toBe(old.coverage);
      expect(neu.breakDate).toBe(old.breakDate);
      expect(neu.reorderUnits).toBe(old.reorder);
    });
  }
});

describe("computeCoverage", () => {
  const i = { soldCur: 0, soldPrev: 0, dayOfMonth: 10, prevMonthDays: 30, today: "2026-10-10", reposicionDias: 30 };
  it("projects the break date from coverage", () => {
    const c = computeCoverage({ ...i, onHand: 20, soldCur: 10 }); // 1/day
    expect(c).toMatchObject({ rate: 1, coverageDays: 20, breakDate: "2026-10-30", reorderUnits: 10 });
  });
  it("has no coverage without sales and 0 when empty", () => {
    expect(computeCoverage({ ...i, onHand: 5 }).coverageDays).toBeNull();
    expect(computeCoverage({ ...i, onHand: 0, soldCur: 10 })).toMatchObject({ coverageDays: 0, breakDate: null, reorderUnits: 30 });
    expect(computeCoverage({ ...i, onHand: -3, soldCur: 10 }).coverageDays).toBe(0);
  });
});
