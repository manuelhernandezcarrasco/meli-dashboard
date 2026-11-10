// STUB (T10): minimal predictLine only. T8 owns this file; replace on merge.
// Log fit convention: ln(sold) = slope * ln(price) + intercept.
import type { Regression } from "~/lib/market";

export function predictLine(reg: Regression, xMin: number, xMax: number, steps: number): { price: number; sold: number }[] {
  const out: { price: number; sold: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const price = reg.mode === "log"
      ? Math.exp(Math.log(xMin) + ((Math.log(xMax) - Math.log(xMin)) * i) / steps)
      : xMin + ((xMax - xMin) * i) / steps;
    const sold = reg.mode === "log" ? Math.exp(reg.slope * Math.log(price) + reg.intercept) : reg.slope * price + reg.intercept;
    out.push({ price, sold });
  }
  return out;
}
