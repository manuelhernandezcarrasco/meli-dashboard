import { daysIn } from "~/lib/dates";
import type { Line, Totals } from "~/lib/contracts";

const round2 = (x: number) => Math.round(x * 100) / 100;

const zero = (): Totals => ({
  ventaMl: 0,
  ventaVa: 0,
  venta: 0,
  costoMl: 0,
  cogs: 0,
  uds: 0,
  ingNetos: 0,
  margen: 0,
});

/** Port of `daily_series` (legacy 1116–1131): one Totals per day of (y, m). */
export function dailySeries(lines: Line[], y: number, m: number): Totals[] {
  const out = Array.from({ length: daysIn(y, m) }, zero);
  const prefix = `${y}-${String(m).padStart(2, "0")}-`;
  for (const l of lines) {
    if (!l.date.startsWith(prefix)) continue;
    const d = out[Number(l.date.slice(8, 10)) - 1]!;
    if (l.channel === "ML") d.ventaMl += l.venta;
    else d.ventaVa += l.venta;
    d.venta += l.venta;
    d.costoMl += l.costoMl;
    d.cogs += l.qty * l.cu;
    d.uds += l.qty;
  }
  for (const d of out) {
    d.ingNetos = d.venta - d.costoMl;
    d.margen = d.ingNetos - d.cogs;
    for (const k of Object.keys(d) as (keyof Totals)[]) d[k] = round2(d[k]);
  }
  return out;
}

/** Port of `acum` (legacy 1134–1139): sum of the first `n` days. */
export function acum(series: Totals[], n: number): Totals {
  const out = zero();
  for (const s of series.slice(0, n)) {
    for (const k of Object.keys(out) as (keyof Totals)[]) out[k] += s[k];
  }
  return out;
}
