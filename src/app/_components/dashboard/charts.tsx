"use client";

import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  ars, pct, short, type AccumPoint, type DailyPoint, type WaterfallStep,
} from "~/lib/dashboard-math";
import { Card } from "./ui";

const AXIS = { stroke: "var(--mut)", fontSize: 11 } as const;
const GRID = { stroke: "var(--line)", vertical: false } as const;
const TOOLTIP_STYLE = {
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  color: "var(--ink)",
  fontSize: 12,
} as const;

const TONE: Record<WaterfallStep["tone"], string> = {
  blue: "var(--blue)", cost: "var(--cost)", net: "var(--net)", navy: "var(--navy)",
};

const tick = (v: number) => short(v);

export function DailyChart({ points, corte }: { points: DailyPoint[]; corte: number }) {
  return (
    <Card title="Venta diaria y margen bruto" small="barras = venta total · línea = Mg.% bruto s/ing. netos">
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart data={points} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="day" {...AXIS} tickLine={false} axisLine={{ stroke: "var(--line)" }} />
            <YAxis yAxisId="y" {...AXIS} tickLine={false} axisLine={false} tickFormatter={tick} width={56} />
            <YAxis yAxisId="y1" orientation="right" {...AXIS} tickLine={false} axisLine={false}
              tickFormatter={(v: number) => `${v}%`} width={40} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ fill: "var(--line)", opacity: 0.4 }}
              labelFormatter={(d) => `Día ${String(d)}`}
              formatter={(v, name) =>
                name === "Mg.% bruto"
                  ? [v == null ? "–" : `${Number(v).toFixed(1)}%`, "Mg. bruto"]
                  : [ars(Number(v)), "Venta"]
              }
            />
            <Bar yAxisId="y" dataKey="venta" name="Venta Total" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {points.map((p) => (
                <Cell key={p.day} fill={p.day === corte ? "var(--navy)" : "var(--blue2)"} />
              ))}
            </Bar>
            <Line yAxisId="y1" type="monotone" dataKey="mgPct" name="Mg.% bruto" stroke="var(--net)"
              strokeWidth={2} dot={{ r: 2, fill: "var(--net)", stroke: "var(--net)" }}
              connectNulls isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export function Waterfall({ steps, venta }: { steps: WaterfallStep[]; venta: number }) {
  const data = steps.map((s) => ({ ...s, range: [s.lo, s.hi] as [number, number] }));
  return (
    <Card title="Del precio al margen" small="mes acumulado">
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={{ stroke: "var(--line)" }} interval={0} />
            <YAxis {...AXIS} tickLine={false} axisLine={false} tickFormatter={tick} width={56} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ fill: "var(--line)", opacity: 0.4 }}
              formatter={(_v, _n, item) => {
                const amount = (item.payload as WaterfallStep).amount;
                return [`${ars(amount)} · ${pct(venta ? amount / venta : null)} s/venta`, ""];
              }}
              separator=""
            />
            <Bar dataKey="range" radius={3} barSize={36} isAnimationActive={false}>
              {data.map((s) => (
                <Cell key={s.label} fill={TONE[s.tone]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export function AccumChart({ points, corte, prevLabel, monthLabel, showPrev }: {
  points: AccumPoint[]; corte: number; prevLabel: string; monthLabel: string; showPrev: boolean;
}) {
  return (
    <Card title={`Venta acumulada vs ${prevLabel}`} small="a igual día">
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={points} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="day" {...AXIS} tickLine={false} axisLine={{ stroke: "var(--line)" }} />
            <YAxis {...AXIS} tickLine={false} axisLine={false} tickFormatter={tick} width={56} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(d) => `Día ${String(d)}`}
              formatter={(v, name) => [ars(Number(v)), String(name)]}
            />
            <Legend verticalAlign="top" align="left" iconType="plainline" height={24}
              wrapperStyle={{ fontSize: 11, color: "var(--mut)" }} />
            {showPrev ? (
              <Line type="linear" dataKey="prev" name={prevLabel} stroke="var(--grey)" strokeWidth={2}
                strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
            ) : null}
            <Line type="linear" dataKey="current" name={monthLabel} stroke="var(--blue)" strokeWidth={2.5}
              dot={(p: { cx?: number; cy?: number; index?: number }) =>
                p.index === corte - 1 && p.cx != null && p.cy != null ? (
                  <circle key="cut" cx={p.cx} cy={p.cy} r={4} fill="var(--blue)" />
                ) : (
                  <g key={p.index} />
                )
              }
              connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
