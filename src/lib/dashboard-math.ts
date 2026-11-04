import type { DashboardData } from "~/lib/contracts";

export type Row = DashboardData["rows"][number];
export type StockRow = DashboardData["stock"][number];
export type Totals = DashboardData["comp"]["prevCierre"];
export type Channel = "all" | "ML" | "VA";

import { STOCK_STATES, type StockState } from "~/lib/contracts";

export { STOCK_STATES, type StockState };

// ---------- formatting (es-AR) ----------
const nf = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat("es-AR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export const fmtInt = (v: number) => nf.format(v);
export const fmtDec1 = (v: number) => nf1.format(v);

/** "$ 1.234.567" */
export const ars = (v: number) =>
  (v < 0 ? "-" : "") + "$ " + nf.format(Math.abs(Math.round(v)));

/** "$ 1,2M" / "$ 345k" */
export const short = (v: number) => {
  const a = Math.abs(v);
  const body =
    a >= 1e6 ? nf1.format(a / 1e6) + "M" : a >= 1e3 ? nf.format(a / 1e3) + "k" : nf.format(a);
  return (v < 0 ? "-" : "") + "$ " + body;
};

/** Ratio -> "12,3%" ("–" when unknown). */
export const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "–" : pctFmt.format(v * 100) + "%";

/** Variation ratio a/b - 1, null when b is 0. */
export const vr = (a: number, b: number): number | null => (b ? a / b - 1 : null);

/** "+12,3%" for badges. */
export const fmtDelta = (v: number) =>
  (v >= 0 ? "+" : "") + nf1.format(v * 100) + "%";

// ---------- aggregation ----------
export interface Agg {
  venta: number;
  costoMl: number;
  cogs: number;
  qty: number;
  orders: number; // distinct ML orders
  assumed: number; // lines with assumed cost
  net: number; // venta - costoMl
  mb: number; // net - cogs
  mg: number | null; // mb / net (net income is what we control; ML costs are not ours)
}

const dayOf = (date: string) => Number(date.slice(8, 10));

export function agg(rows: readonly Row[]): Agg {
  let venta = 0;
  let costoMl = 0;
  let cogs = 0;
  let qty = 0;
  let assumed = 0;
  const orders = new Set<string>();
  for (const r of rows) {
    venta += r.sale;
    costoMl += r.costML;
    cogs += r.cogs;
    qty += r.qty;
    if (r.channel === "ML") orders.add(r.order);
    if (r.assumed) assumed++;
  }
  const net = venta - costoMl;
  const mb = net - cogs;
  return {
    venta, costoMl, cogs, qty, orders: orders.size, assumed, net, mb,
    mg: net ? mb / net : null,
  };
}

/** Same shape the previous-month comparison uses. */
export interface Cmp {
  venta: number;
  costoMl: number;
  cogs: number;
  net: number;
  mb: number;
}
export const toCmp = (t: Pick<Totals, "venta" | "costoMl" | "cogs">): Cmp => ({
  venta: t.venta,
  costoMl: t.costoMl,
  cogs: t.cogs,
  net: t.venta - t.costoMl,
  mb: t.venta - t.costoMl - t.cogs,
});

export function prevAccum(data: DashboardData, n: number): Cmp {
  const t = { venta: 0, costoMl: 0, cogs: 0 };
  for (const d of data.comp.prevDaily.slice(0, n)) {
    t.venta += d.venta;
    t.costoMl += d.costoMl;
    t.cogs += d.cogs;
  }
  return toCmp(t);
}

// ---------- context ----------
/** Month of `updatedAt` ("dd/MM/yyyy HH:mm") equals the data month. */
export function isCurrentMonth(data: DashboardData): boolean {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(data.updatedAt);
  return !!m && Number(m[3]) === data.y && Number(m[2]) === data.m;
}

/** Day of month the dashboard is "at" (today when live, last day with sales otherwise). */
export function cutoffDay(data: DashboardData): number {
  if (isCurrentMonth(data) && data.comp.cutDay > 0) return data.comp.cutDay;
  return data.rows.reduce((m, r) => Math.max(m, dayOf(r.date)), 0) || 1;
}

export function categories(data: DashboardData): string[] {
  return [...new Set(data.rows.map((r) => r.cat))].sort();
}

export function filterRows(data: DashboardData, channel: Channel, cat: string): Row[] {
  return data.rows.filter(
    (r) => (channel === "all" || r.channel === channel) && (cat === "all" || r.cat === cat),
  );
}

export function upToDay(rows: readonly Row[], day: number): Row[] {
  return rows.filter((r) => dayOf(r.date) <= day);
}

// ---------- KPI blocks ----------
export interface KpiCard {
  label: string;
  value: string;
  /** variation vs previous month; null = no comparison */
  delta: number | null;
  /** for costs, a rise is bad */
  inverse: boolean;
  /** secondary text */
  sub: string;
  /** secondary text rendered as a warning */
  warn?: boolean;
  highlight?: boolean;
  /** optional badge inside the sub line (projection vs previous close) */
  subDelta?: number | null;
  subSuffix?: string;
}

export interface KpiBlock {
  title: string;
  vs: string;
  cards: KpiCard[];
}

function buildCards(t: Agg, p: Cmp | null, sub1: string): KpiCard[] {
  const d = (a: number, b: number | undefined) => (p && b !== undefined ? vr(a, b) : null);
  return [
    { label: "Venta Total", value: ars(t.venta), delta: d(t.venta, p?.venta), inverse: false, sub: sub1 },
    {
      label: "Costo ML", value: ars(t.costoMl), delta: d(t.costoMl, p?.costoMl), inverse: true,
      sub: t.venta ? pct(t.costoMl / t.venta) + " s/venta" : "",
    },
    { label: "Ingresos Netos", value: ars(t.net), delta: d(t.net, p?.net), inverse: false, sub: "" },
    {
      label: "COGS", value: ars(t.cogs), delta: d(t.cogs, p?.cogs), inverse: true,
      sub: t.assumed ? `${t.assumed} líneas c/costo asumido` : "", warn: t.assumed > 0,
    },
    {
      label: "Margen Bruto", value: ars(t.mb), delta: d(t.mb, p?.mb), inverse: false,
      sub: "Mg. " + pct(t.mg) + (p && p.net ? ` · ant. ${pct(p.mb / p.net)}` : ""),
      highlight: true,
    },
  ];
}

export interface Dashboard {
  corte: number;
  sameMonth: boolean;
  full: boolean;
  hoy: Agg;
  mes: Agg;
  projection: number;
  projectionDelta: number | null;
  kHoy: KpiBlock;
  kMes: KpiBlock;
}

export function computeDashboard(data: DashboardData, channel: Channel, cat: string): Dashboard {
  const C = data.comp;
  const rows = filterRows(data, channel, cat);
  const full = channel === "all" && cat === "all";
  const sameMonth = isCurrentMonth(data);
  const corte = cutoffDay(data);
  const pl = C.prevLabel.split(" ")[0] ?? C.prevLabel;
  const dayIso = `${data.y}-${String(data.m).padStart(2, "0")}-${String(corte).padStart(2, "0")}`;
  const hoy = agg(rows.filter((r) => r.date === dayIso));
  const mes = agg(upToDay(rows, corte));

  const live = sameMonth && C.prevToday != null && corte === C.cutDay;
  const pMes = full ? (live ? toCmp(C.prevAccumAtCut) : prevAccum(data, corte)) : null;

  const proj = (mes.venta / corte) * C.nDays;
  const projectionDelta = full && C.prevCierre.venta ? vr(proj, C.prevCierre.venta) : null;

  // "Hoy" compares against yesterday (same time of day while the day is in progress).
  // Day 1 has no yesterday in the loaded month, so it falls back to the previous month's last day.
  const cutTime = live ? C.cutTime : null;
  let pHoy: Cmp | null = null;
  let vsHoy: string;
  if (corte > 1) {
    const ydayIso = `${data.y}-${String(data.m).padStart(2, "0")}-${String(corte - 1).padStart(2, "0")}`;
    const yRows = rows.filter(
      (r) => r.date === ydayIso && (!cutTime || (r.time || "00:00") <= cutTime),
    );
    pHoy = toCmp(agg(yRows));
    vsHoy = cutTime ? `vs ayer hasta las ${cutTime}` : "vs ayer";
  } else {
    const last = C.prevDaily[C.prevDaily.length - 1];
    pHoy = full && last ? toCmp(last) : null;
    vsHoy = "vs ayer";
  }

  return {
    corte, sameMonth, full, hoy, mes,
    projection: proj, projectionDelta,
    kHoy: {
      title: (sameMonth ? "Hoy · " : "Último día · ") + dayLabel(data.y, data.m, corte),
      vs: vsHoy,
      cards: buildCards(hoy, pHoy, `${hoy.orders} órdenes ML · ${fmtInt(hoy.qty)} uds`),
    },
    kMes: {
      title: `Mes acumulado · días 1–${corte}` + (full ? ` vs ${C.prevLabel} a igual día` : ""),
      vs: "",
      cards: buildCards(mes, pMes, `Proy. ${short(proj)}`).map((c, i) =>
        i === 0 && projectionDelta !== null
          ? { ...c, subDelta: projectionDelta, subSuffix: `vs cierre ${pl}` }
          : c,
      ),
    },
  };
}

export function dayLabel(y: number, m: number, d: number): string {
  return new Date(y, m - 1, d).toLocaleDateString("es-AR", {
    weekday: "long", day: "numeric", month: "short",
  });
}

// ---------- charts ----------
export interface DailyPoint {
  day: number;
  venta: number;
  /** Mg.% bruto s/ingresos netos (0..100), null when no net income or after the cutoff */
  mgPct: number | null;
}

export function dailySeries(data: DashboardData, rows: readonly Row[], corte: number): DailyPoint[] {
  return Array.from({ length: data.comp.nDays }, (_, i) => {
    const day = i + 1;
    const t = agg(rows.filter((r) => dayOf(r.date) === day));
    return { day, venta: t.venta, mgPct: day <= corte && t.net ? (t.mb / t.net) * 100 : null };
  });
}

export interface WaterfallStep {
  label: string;
  lo: number;
  hi: number;
  tone: "blue" | "cost" | "net" | "navy";
  /** signed amount of this step */
  amount: number;
}

export function waterfall(mes: Pick<Agg, "venta" | "net" | "mb">): WaterfallStep[] {
  return [
    { label: "Venta Total", lo: 0, hi: mes.venta, tone: "blue", amount: mes.venta },
    { label: "Costo ML", lo: mes.net, hi: mes.venta, tone: "cost", amount: mes.net - mes.venta },
    { label: "Ingresos Netos", lo: 0, hi: mes.net, tone: "net", amount: mes.net },
    { label: "COGS", lo: mes.mb, hi: mes.net, tone: "cost", amount: mes.mb - mes.net },
    { label: "Margen Bruto", lo: 0, hi: mes.mb, tone: "navy", amount: mes.mb },
  ];
}

export interface AccumPoint {
  day: number;
  current: number | null;
  prev: number | null;
}

export function accumSeries(
  data: DashboardData, rows: readonly Row[], corte: number, showPrev: boolean,
): AccumPoint[] {
  let s = 0;
  let sp = 0;
  return Array.from({ length: data.comp.nDays }, (_, i) => {
    const day = i + 1;
    const t = agg(rows.filter((r) => dayOf(r.date) === day));
    const current = day <= corte ? (s += t.venta) : null;
    const pd = data.comp.prevDaily[i];
    const prev = pd ? (sp += pd.venta) : null;
    return { day, current, prev: showPrev ? prev : null };
  });
}

// ---------- tables ----------
export interface CategoryRow { cat: string; t: Agg; share: number }

export function categoryTable(rows: readonly Row[], corte: number): { rows: CategoryRow[]; total: Agg } {
  const scoped = upToDay(rows, corte);
  const total = agg(scoped);
  const by = new Map<string, Row[]>();
  for (const r of scoped) by.set(r.cat, [...(by.get(r.cat) ?? []), r]);
  const out = [...by.entries()]
    .map(([cat, rs]) => {
      const t = agg(rs);
      return { cat, t, share: total.venta ? (t.venta / total.venta) * 100 : 0 };
    })
    .sort((a, b) => b.t.venta - a.t.venta);
  return { rows: out, total };
}

export function salesFeed(rows: readonly Row[], limit = 40): Row[] {
  return rows
    .slice()
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
    .slice(0, limit);
}

/** Gross margin of one sale: (net income from ML - COGS), in pesos. */
export const marginAmount = (r: Row) => r.sale - r.costML - r.cogs;

/** Gross margin over net income: (net income - COGS) / net income. */
export const marginRatio = (r: Row) => {
  const net = r.sale - r.costML;
  return net ? marginAmount(r) / net : null;
};

export interface TopProduct { desc: string; t: Agg }

export function topProducts(rows: readonly Row[], corte: number, limit = 15): TopProduct[] {
  const by = new Map<string, { desc: string; rs: Row[] }>();
  for (const r of upToDay(rows, corte)) {
    const key = r.ean || r.desc;
    const e = by.get(key) ?? { desc: r.desc, rs: [] };
    e.rs.push(r);
    by.set(key, e);
  }
  return [...by.values()]
    .map((x) => ({ desc: x.desc, t: agg(x.rs) }))
    .sort((a, b) => b.t.venta - a.t.venta)
    .slice(0, limit);
}

export function alerts(data: DashboardData, mes: Pick<Agg, "assumed">): string[] {
  const pl = data.comp.prevLabel.split(" ")[0] ?? "";
  const out: string[] = [];
  if (mes.assumed) {
    out.push(`${mes.assumed} líneas con costo asumido (sin CU real en el cierre de ${pl}).`);
  }
  if (data.unmatched.length) {
    out.push(
      `${data.unmatched.length} publicaciones de ML sin EAN — completar “Mapeo ML”: ` +
        data.unmatched.slice(0, 3).map((u) => u.title).join(" · "),
    );
  }
  return out;
}

export interface MissingCostProduct {
  key: string;
  desc: string;
  ean: string;
  cat: string;
  lines: number;
  qty: number;
  venta: number;
}

/** Products with at least one line whose cost is assumed (no real CU), biggest sales first. */
export function missingCosts(rows: readonly Pick<Row, "ean" | "desc" | "cat" | "qty" | "sale" | "assumed">[]): MissingCostProduct[] {
  const map = new Map<string, MissingCostProduct>();
  for (const r of rows) {
    if (!r.assumed) continue;
    const key = r.ean || r.desc;
    const cur = map.get(key) ?? { key, desc: r.desc, ean: r.ean, cat: r.cat, lines: 0, qty: 0, venta: 0 };
    cur.lines += 1;
    cur.qty += r.qty;
    cur.venta += r.sale;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.venta - a.venta);
}

// ---------- stock ----------
export function stockCounts(stock: readonly StockRow[], cat: string): Record<StockState, number> {
  const cnt: Record<StockState, number> = {
    "Vendido sin stock": 0, Agotado: 0, Crítico: 0, Bajo: 0, OK: 0,
  };
  for (const s of stock) if (cat === "all" || s.cat === cat) cnt[s.state]++;
  return cnt;
}

export function stockRows(
  stock: readonly StockRow[], cat: string, selected: ReadonlySet<StockState>,
): StockRow[] {
  return stock.filter((s) => (cat === "all" || s.cat === cat) && selected.has(s.state));
}

/** "2026-10-31" -> "31/10" */
export function fmtShortDate(iso: string | null): string {
  if (!iso) return "–";
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

// ---------- freshness ----------
export function parseUpdatedAt(updatedAt: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(updatedAt);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00-03:00`);
}

export function freshness(data: DashboardData, now: number): { mins: number; stale: boolean } {
  const upd = parseUpdatedAt(data.updatedAt);
  const mins = upd ? Math.max(0, Math.round((now - upd.getTime()) / 60000)) : 0;
  return { mins, stale: mins > data.refreshMinutes * 2 + 2 };
}

export function footnote(data: DashboardData): string {
  const pl = data.comp.prevLabel;
  return `Venta = precio × uds (Ingresos por productos). Costo ML = cargo por venta + envío a cargo del vendedor + impuestos/retenciones de cada operación según Mercado Pago (${pct(data.taxPct)} estimado si el pago aún no tiene detalle); el export mensual sigue siendo el dato definitivo. COGS = uds × CU Pond. del cierre de ${pl}; sin costo real, margen asumido por categoría. Comparación vs ${pl} sólo con filtros en “Todos”.`;
}
