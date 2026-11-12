import { ars, fmtDec1 } from "~/lib/dashboard-math";
import type { Review, ReviewLine } from "./types";

export const fmtFactor = (f: number) => `×${f.toFixed(5).replace(".", ",")}`;
export const fmtPctFactor = (f: number) =>
  `${f >= 1 ? "+" : "−"}${Math.abs((f - 1) * 100).toFixed(2).replace(".", ",")} %`;
export const fmtQty = (n: number) => fmtDec1(n);

/** "$13,77 M" style for big amounts, plain ARS otherwise. */
export function fmtMoneyShort(n: number): string {
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2).replace(".", ",")} M`;
  return ars(n);
}

export const isUnresolved = (l: ReviewLine) => l.resolution === "unresolved" && !l.skipped;
export const isActive = (l: ReviewLine) => !l.skipped;

/** Landed unit cost for a given factor (S9 `landedCost`: lineSubtotal / quantity × feeFactor, so the discount is included). */
export const landed = (l: ReviewLine, factor: number) => (l.lineSubtotal / l.quantity) * factor;

/** Moving weighted average after receiving `qty` at `unit`; zero/negative stock restarts the average. */
export function projectCost(stock: number, cost: number, qty: number, unit: number): number {
  if (stock <= 0) return unit;
  return (stock * cost + qty * unit) / (stock + qty);
}

export interface Projection {
  stockNow: number | null;
  stockAfter: number | null;
  costNow: number | null;
  costAfter: number | null;
  landedUnit: number;
}
export function project(l: ReviewLine, factor: number): Projection {
  const unit = landed(l, factor);
  const stockNow = l.current?.onHand ?? l.stockNow ?? null;
  const costNow = l.current?.unitCost ?? l.costNow ?? null;
  const known = l.productId != null && stockNow != null && costNow != null && !l.skipped;
  return {
    landedUnit: unit,
    stockNow,
    costNow,
    stockAfter: known ? stockNow + l.quantity : null,
    costAfter: known ? projectCost(stockNow, costNow, l.quantity, unit) : null,
  };
}

export function summarize(r: Review) {
  const active = r.lines.filter(isActive);
  return {
    products: active.length,
    units: active.reduce((s, l) => s + l.quantity, 0),
    amount: active.reduce((s, l) => s + l.quantity * landed(l, r.feeFactor), 0),
    unresolved: r.lines.filter(isUnresolved).length,
    skipped: r.lines.length - active.length,
  };
}

export const summaryText = (s: ReturnType<typeof summarize>) =>
  `${s.products} ${s.products === 1 ? "producto" : "productos"}, ${fmtQty(s.units)} unidades, +${fmtMoneyShort(s.amount)}`;

export const fmtDate = (d: string) => d.slice(0, 10).split("-").reverse().join("/");
