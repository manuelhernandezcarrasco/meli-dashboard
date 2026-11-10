"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid, ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis,
} from "recharts";

import { fmtInt, short } from "~/lib/dashboard-math";
import type { MarketResearch, RegressionMode } from "~/lib/market";
import { predictLine } from "~/server/market/stats";
import { Card } from "../dashboard/ui";
import { MarketTooltip } from "./MarketTooltip";

const AXIS = { stroke: "var(--mut)", fontSize: 11 } as const;
const REASON: Record<MarketResearch["excluded"][number]["reason"], string> = {
  price_outlier: "Precio atípico",
  sales_outlier: "Ventas atípicas",
  cap: "Fuera del límite de vendedores",
};
const SCALE_LABEL: Record<RegressionMode, string> = { log: "Log", linear: "Lineal" };

const r2Fmt = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const openPermalink = (p: unknown) => {
  const link = (p as { permalink?: string } | undefined)?.permalink;
  if (link) window.open(link, "_blank", "noopener,noreferrer");
};

function Dot({ cx, cy, fill, r }: { cx?: number; cy?: number; fill: string; r: number; [k: string]: unknown }) {
  if (cx == null || cy == null) return null;
  return <circle cx={cx} cy={cy} r={r} fill={fill} fillOpacity={0.85} stroke="var(--card)" strokeWidth={1} style={{ cursor: "pointer" }} />;
}

export function MarketChart({ data, size }: {
  data: MarketResearch;
  /** fixed pixel size (tests / jsdom, where ResponsiveContainer measures 0) */
  size?: { width: number; height: number };
}) {
  // Other sellers' sales are unknown (their items are closed to us): they sit on the baseline,
  // which a log axis can't draw, so the scale is forced linear while any are present.
  const hasUnknownSales = data.points.some((p) => p.soldQuantity == null);
  const modes = (["log", "linear"] as const).filter((m) => data.regression[m] != null && !(hasUnknownSales && m === "log"));
  const [picked, setPicked] = useState<RegressionMode>("log");
  const mode: RegressionMode = hasUnknownSales ? "linear" : modes.includes(picked) ? picked : (modes[0] ?? "log");
  const reg = data.regression[mode];
  const log = mode === "log";

  const { others, ours } = useMemo(() => ({
    others: data.points.filter((p) => !p.isOurs),
    ours: data.points.filter((p) => p.isOurs),
  }), [data.points]);

  const line = useMemo(() => {
    if (!reg || data.points.length === 0) return [];
    // T8's fit is price = f(sold): sample over units sold, plot (price, sold).
    const sold = data.points.flatMap((p) => (p.soldQuantity == null ? [] : [p.soldQuantity]));
    if (sold.length === 0) return [];
    return predictLine(reg, Math.min(...sold), Math.max(...sold), 40);
  }, [reg, data.points]);

  if (data.points.length === 0) {
    return (
      <Card title={data.catalogTitle} small="precio vs. unidades vendidas">
        <p className="m-0 py-10 text-center text-sm text-mut">No hay datos de mercado para este producto.</p>
      </Card>
    );
  }

  const scale = log ? "log" : "linear";
  const domain: [string | number, string | number] = log ? ["auto", "auto"] : [0, "auto"];
  // log axes can't draw sold = 0
  const plot = <T extends { soldQuantity: number | null }>(rows: T[]) =>
    (log ? rows.filter((p) => (p.soldQuantity ?? 0) > 0) : rows.map((p) => ({ ...p, soldQuantity: p.soldQuantity ?? 0 })));

  const chart = (
    <ComposedChart {...(size ?? {})} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
      <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
      <XAxis type="number" dataKey="price" name="Precio" scale={scale} domain={domain} {...AXIS}
        tickFormatter={(v: number) => short(v)} allowDataOverflow />
      <YAxis type="number" dataKey="soldQuantity" name="Vendidos" scale={scale} domain={log ? ["auto", "auto"] : [0, "auto"]} {...AXIS}
        tickFormatter={(v: number) => fmtInt(v)} width={48} allowDataOverflow />
      <Tooltip content={<MarketTooltip />} shared={false} cursor={{ strokeDasharray: "3 3" }} isAnimationActive={false} />
      <Scatter name="Otros vendedores" data={plot(others)} fill="var(--grey)" isAnimationActive={false}
        shape={<Dot fill="var(--grey)" r={4} />} onClick={openPermalink} />
      <Scatter name="Nuestras publicaciones" data={plot(ours)} fill="var(--cost)" isAnimationActive={false}
        shape={<Dot fill="var(--cost)" r={7} />} onClick={openPermalink} />
      {reg && (
        <Line data={line.filter((l) => l.sold > 0 && l.price > 0)} dataKey="sold" xAxisId={0} yAxisId={0} type="monotone"
          stroke="var(--blue)" strokeWidth={2} dot={false} activeDot={false} legendType="none"
          isAnimationActive={false} name="Ajuste" />
      )}
    </ComposedChart>
  );

  return (
    <Card title={data.catalogTitle} small="precio vs. unidades vendidas">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-mut">
        <span>Escala</span>
        <div role="group" aria-label="Escala" className="inline-flex overflow-hidden rounded-md border border-line">
          {modes.map((m) => (
            <button key={m} type="button" aria-pressed={m === mode} onClick={() => setPicked(m)}
              className={`cursor-pointer border-0 px-2.5 py-0.5 text-xs ${m === mode ? "bg-navy text-card" : "bg-card text-ink"}`}>
              {SCALE_LABEL[m]}
            </button>
          ))}
        </div>
        {hasUnknownSales && <span>Ventas de otros vendedores no disponibles: se muestran sobre el eje.</span>}
        {reg && <span data-testid="fit-stats">R² {r2Fmt.format(reg.r2)} · n = {fmtInt(reg.n)}</span>}
        <span className="ml-auto flex items-center gap-3">
          <Legend color="var(--grey)" label="Otros" />
          <Legend color="var(--cost)" label="Nuestras" />
          {reg && <Legend color="var(--blue)" label="Ajuste" />}
        </span>
      </div>
      {size ? (
        <div data-testid="market-plot">{chart}</div>
      ) : (
        <div className="h-[360px]" data-testid="market-plot">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>{chart}</ResponsiveContainer>
        </div>
      )}
      <Excluded excluded={data.excluded} />
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />{label}
    </span>
  );
}

function Excluded({ excluded }: { excluded: MarketResearch["excluded"] }) {
  const [open, setOpen] = useState(false);
  if (excluded.length === 0) return null;
  return (
    <section className="mt-3 border-t border-line pt-2.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 border-0 bg-transparent p-0 text-left">
        <h4 className="m-0 text-[13px] font-semibold text-warn">Excluidos ({excluded.length})</h4>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden
          className={`shrink-0 text-mut transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M2 4 L6 8 L10 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="m-0 mt-2 list-none p-0 text-xs">
          {excluded.map(({ point, reason }) => (
            <li key={point.itemId} className="flex justify-between gap-3 border-b border-line py-1 last:border-0">
              <a href={point.permalink} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-blue">
                {point.sellerNickname} · {point.title}
              </a>
              <span className="shrink-0 text-mut">{REASON[reason]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
