import { daysIn, monthLabel, nowArg, prevYm } from "~/lib/dates";
import type {
  Base,
  BusinessConfig,
  DashboardData,
  Gtins,
  Inputs,
  Order,
  PrevCierre,
  ShipCosts,
  StockItem,
  StockRow,
  TaxMap,
} from "~/lib/contracts";
import { buildLines } from "./lines";
import type { Matcher } from "~/lib/product-match";
import { calibrateTaxPct, matchProposalsFrom, unmatchedFrom } from "./tax";
import { buildComparison, cutDayFor } from "./comparison";

export type StockFn = (
  base: Base,
  lines: ReturnType<typeof buildLines>,
  inputs: Inputs,
  cfg: BusinessConfig,
  y: number,
  m: number,
  cutDay: number,
  prevDays: number,
) => StockItem[];

export interface ComputeDashboardInput {
  orders: Order[];
  prevOrders: Order[];
  shipCosts: ShipCosts;
  gtins: Gtins;
  taxes: TaxMap;
  base: Base;
  prevCierre: PrevCierre;
  inputs: Inputs;
  cfg: BusinessConfig;
  y: number;
  m: number;
  now: Date;
  stockFn: StockFn;
  /** Overrides the derived cut day (demo data frozen in time). */
  cutDay?: number;
  /** Title-similarity fallback for listings without SKU / EAN / GTIN; off when omitted. */
  fuzzy?: Matcher;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const p2 = (n: number) => String(n).padStart(2, "0");

const toStockRow = (x: StockItem): StockRow => ({
  desc: x.desc.slice(0, 60),
  cat: x.cat,
  ean: x.ean,
  initial: x.initial,
  inflow: x.inflow,
  sold: x.sold,
  remaining: x.remaining,
  rate: x.rate,
  rateSource: x.rateSource,
  coverage: x.coverage,
  breakDate: x.breakDate,
  reorder: x.reorder,
  state: x.state,
});

/** Port of the `run_sync` orchestration + `write_dashboard` data (legacy 1079–1099, 1255–1334). */
export function computeDashboard(i: ComputeDashboardInput): DashboardData {
  const { base, inputs, y, m, now } = i;
  const [py, pm] = prevYm(y, m);

  let taxPct: number;
  if (typeof i.cfg.impuestosMlPctEstimado === "number") {
    taxPct = i.cfg.impuestosMlPctEstimado;
  } else {
    const zero = { ...i.cfg, impuestosMlPctEstimado: 0 };
    const p0 = buildLines(i.prevOrders, i.shipCosts, i.gtins, base, inputs, zero, py, pm, undefined, i.fuzzy);
    taxPct = calibrateTaxPct(p0, i.prevCierre);
  }
  const cfg: BusinessConfig = { ...i.cfg, impuestosMlPctEstimado: taxPct };

  const lines = buildLines(i.orders, i.shipCosts, i.gtins, base, inputs, cfg, y, m, i.taxes, i.fuzzy);
  const prevLines = buildLines(i.prevOrders, i.shipCosts, i.gtins, base, inputs, cfg, py, pm, i.taxes, i.fuzzy);

  const cutDay = i.cutDay ?? cutDayFor(lines, y, m, now);
  const comp = buildComparison({ lines, prevLines, prevCierre: i.prevCierre, y, m, now, cutDay });
  const stock = i.stockFn(base, lines, inputs, cfg, y, m, cutDay, daysIn(py, pm));

  const t = nowArg(now);
  return {
    rows: lines.map((l) => ({
      date: l.date,
      time: l.time,
      channel: l.channel,
      order: l.order,
      ean: l.ean,
      desc: l.desc.slice(0, 70),
      cat: l.cat,
      qty: l.qty,
      sale: round2(l.venta),
      costML: round2(l.costoMl),
      feeML: round2(l.cargoVenta),
      cuotasML: round2(l.cuotas),
      shipML: round2(l.envio),
      taxML: round2(l.impEst),
      cogs: round2(l.qty * l.cu),
      assumed: !(l.costSource.startsWith("Real") || l.costSource === "Override"),
    })),
    stock: stock.map(toStockRow),
    updatedAt: `${p2(t.d)}/${p2(t.m)}/${t.y} ${t.time}`,
    monthLabel: monthLabel(y, m),
    y,
    m,
    unmatched: unmatchedFrom(lines),
    suggestions: matchProposalsFrom(lines, base, "suggest"),
    autoMatches: matchProposalsFrom(lines, base, "auto"),
    refreshMinutes: Math.trunc(cfg.refreshMinutes),
    taxPct,
    thresholds: { crit: cfg.stockCriticoDias, low: cfg.stockBajoDias, repo: cfg.reposicionDias },
    comp: {
      prevLabel: comp.prevLabel,
      prevCierre: comp.prevCierre,
      prevDaily: comp.prevDaily,
      nDays: comp.nDays,
      prevToday: comp.prevToday,
      cutTime: comp.cutTime,
      prevAccumAtCut: comp.prevAccumAtCut,
      cutDay: comp.cutDay,
    },
  };
}
