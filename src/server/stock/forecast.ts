import { daysIn, monthRangeArg, nowArg, prevYm } from "~/lib/dates";
import { loadBusinessConfig } from "~/server/config";
import { readStockFacts, type FactsWindow, type ProductStockFacts } from "~/server/store/stockAlerts";

/** Days-of-coverage forecast of one product (a forecast of the stock movement, not a stored fact). */
export interface Coverage {
  /** Units sold per day: this month so far, else last month's average (0 when neither sold). */
  rate: number;
  rateSource: "mes actual" | "mes anterior";
  /** onHand / rate. 0 when nothing is left; null when there is stock but no sales to project. */
  coverageDays: number | null;
  /** Argentine day (YYYY-MM-DD) the stock runs out; null when coverageDays is null or 0. */
  breakDate: string | null;
  /** Units to buy to cover `reposicionDias`. */
  reorderUnits: number;
}

export interface CoverageInput {
  onHand: number;
  /** Net units sold this month up to and including today. */
  soldCur: number;
  /** Net units sold in the previous month. */
  soldPrev: number;
  /** Day of month of `today` (elapsed days of the current month). */
  dayOfMonth: number;
  prevMonthDays: number;
  /** Argentine date, YYYY-MM-DD. */
  today: string;
  reposicionDias: number;
}

/** Python 3 `round(x, digits)`: half-even, same helper as the legacy `computeStock`. */
function pyRound(x: number, digits = 0): number {
  const f = 10 ** digits;
  const s = x * f;
  const fl = Math.floor(s);
  const diff = s - fl;
  const r = Math.abs(diff - 0.5) < 1e-9 ? (fl % 2 === 0 ? fl : fl + 1) : Math.round(s);
  return r / f;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Same semantics as the legacy `computeStock` (rate, coverage, break date, reorder), on ledger numbers. */
export function computeCoverage(i: CoverageInput): Coverage {
  const rCur = i.dayOfMonth ? i.soldCur / i.dayOfMonth : 0;
  const rPrev = i.prevMonthDays ? i.soldPrev / i.prevMonthDays : 0;
  const useCur = i.soldCur > 0;
  const rate = useCur ? rCur : rPrev;
  const cov = rate > 0 && i.onHand > 0 ? i.onHand / rate : i.onHand <= 0 ? 0 : null;
  return {
    rate: pyRound(rate, 2),
    rateSource: useCur ? "mes actual" : "mes anterior",
    coverageDays: cov === null ? null : pyRound(cov, 1),
    breakDate: cov ? addDays(i.today, Math.trunc(cov)) : null,
    reorderUnits: Math.max(0, pyRound(rate * i.reposicionDias - Math.max(i.onHand, 0))),
  };
}

/** Month windows (Argentine time) the sold-units facts are read over. */
export function factsWindow(now: Date): { window: FactsWindow; dayOfMonth: number; prevMonthDays: number; today: string } {
  const t = nowArg(now);
  const [py, pm] = prevYm(t.y, t.m);
  return {
    window: { prevStart: monthRangeArg(py, pm).start, curStart: monthRangeArg(t.y, t.m).start, curEnd: monthRangeArg(t.y, t.m).end },
    dayOfMonth: t.d,
    prevMonthDays: daysIn(py, pm),
    today: t.date,
  };
}

export function coverageOf(f: ProductStockFacts, w: ReturnType<typeof factsWindow>, reposicionDias: number): Coverage {
  return computeCoverage({
    onHand: f.onHand, soldCur: f.soldCur, soldPrev: f.soldPrev,
    dayOfMonth: w.dayOfMonth, prevMonthDays: w.prevMonthDays, today: w.today, reposicionDias,
  });
}

/** Coverage of one product from the ledger. Returns null when the product does not exist (or is archived). */
export async function coverage(accountId: string, productId: number, now = new Date()): Promise<Coverage | null> {
  const w = factsWindow(now);
  const [f] = await readStockFacts(accountId, w.window, productId);
  return f ? coverageOf(f, w, loadBusinessConfig().reposicionDias) : null;
}

/** Units sold per day for each product (this month so far, else last month's average) from one set-based read. */
export async function dailyRates(accountId: string, productIds: number[], now = new Date()): Promise<Map<number, number | null>> {
  const w = factsWindow(now);
  const cfg = loadBusinessConfig();
  const wanted = new Set(productIds);
  const out = new Map<number, number | null>(productIds.map((id) => [id, null]));
  for (const f of await readStockFacts(accountId, w.window)) {
    if (wanted.has(f.productId)) out.set(f.productId, coverageOf(f, w, cfg.reposicionDias).rate);
  }
  return out;
}
