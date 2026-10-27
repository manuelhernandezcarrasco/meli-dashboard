// owner: T4
import type { Base, BusinessConfig, Inputs, Line, StockItem, StockRow } from "~/lib/contracts";

const ESTADOS: StockItem["state"][] = ["Vendido sin stock", "Agotado", "Crítico", "Bajo", "OK"];

/** Python 3 `round(x, digits)`: round-half-even on the decimal repr. */
function pyRound(x: number, digits = 0): number {
  const f = 10 ** digits;
  const s = x * f;
  const fl = Math.floor(s);
  const diff = s - fl;
  // treat near-ties (float noise from the multiply) as exact ties
  let r: number;
  if (Math.abs(diff - 0.5) < 1e-9) r = fl % 2 === 0 ? fl : fl + 1;
  else r = Math.round(s);
  return r / f;
}

const p2 = (n: number) => String(n).padStart(2, "0");

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}

export function computeStock(
  base: Base,
  lines: Line[],
  inputs: Inputs,
  cfg: BusinessConfig,
  y: number,
  m: number,
  cutDay: number,
  prevDays: number,
): StockItem[] {
  const crit = cfg.stockCriticoDias;
  const bajo = cfg.stockBajoDias;
  const repo = cfg.reposicionDias;
  const ym = `${y}-${p2(m)}`;
  const cutDate = `${ym}-${p2(cutDay)}`;

  const sold = new Map<string, number>();
  const inflow = new Map<string, number>();
  for (const l of lines) {
    if (l.ean && l.date.startsWith(ym) && l.date <= cutDate) {
      sold.set(l.ean, (sold.get(l.ean) ?? 0) + l.qty);
    }
  }
  for (const i of inputs.ingresos) {
    if (i.date.startsWith(ym) && i.date <= cutDate) {
      inflow.set(i.ean, (inflow.get(i.ean) ?? 0) + i.qty);
    }
  }

  const out: StockItem[] = [];
  for (const [ean, b] of Object.entries(base)) {
    const v = sold.get(ean) ?? 0;
    const n = inflow.get(ean) ?? 0;
    const initial = b.stock;
    const remaining = initial + n - v;
    const rCur = cutDay ? v / cutDay : 0;
    const rPrev = prevDays ? b.udsPrev / prevDays : 0;
    const [rate, rateSource] = v ? ([rCur, "mes actual"] as const) : ([rPrev, "mes anterior"] as const);
    if (rate <= 0 && remaining <= 0) continue;
    const cov = rate > 0 && remaining > 0 ? remaining / rate : remaining <= 0 ? 0 : null;
    let state: StockItem["state"];
    if (remaining < 0) state = "Vendido sin stock";
    else if (remaining === 0) state = "Agotado";
    else if (cov !== null && cov < crit) state = "Crítico";
    else if (cov !== null && cov < bajo) state = "Bajo";
    else state = "OK";
    out.push({
      ean,
      desc: b.desc,
      cat: b.cat,
      initial,
      inflow: n,
      sold: v,
      remaining,
      rate: pyRound(rate, 2),
      rateSource,
      coverage: cov === null ? null : pyRound(cov, 1),
      breakDate: cov ? addDays(cutDate, Math.trunc(cov)) : null,
      reorder: Math.max(0, pyRound(rate * repo - Math.max(remaining, 0))),
      state,
      cu: b.cu,
    });
  }

  const key = (x: StockItem): number[] => [
    ESTADOS.indexOf(x.state),
    x.state === "Vendido sin stock" ? x.remaining : 0,
    x.state === "Agotado" ? -x.rate : 0,
    x.coverage !== null ? x.coverage : 9e9,
    -x.rate,
  ];
  return out.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i]! !== kb[i]!) return ka[i]! - kb[i]!;
    }
    return 0;
  });
}

export function toStockRow(s: StockItem): StockRow {
  return {
    desc: s.desc.slice(0, 60),
    cat: s.cat,
    ean: s.ean,
    initial: s.initial,
    inflow: s.inflow,
    sold: s.sold,
    remaining: s.remaining,
    rate: s.rate,
    rateSource: s.rateSource,
    coverage: s.coverage,
    breakDate: s.breakDate,
    reorder: s.reorder,
    state: s.state,
  };
}
