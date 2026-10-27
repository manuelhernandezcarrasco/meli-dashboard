"use client";

import type { ReactNode } from "react";
import type { Channel } from "~/lib/dashboard-math";

const CHANNELS: ReadonlyArray<{ v: Channel; label: string }> = [
  { v: "all", label: "Todos" },
  { v: "ML", label: "MercadoLibre" },
  { v: "VA", label: "Venta directa" },
];

export function Header({
  monthLabel, updatedAt, mins, stale, refreshMinutes, demo,
  channel, onChannel, cat, onCat, categories, actions,
}: {
  monthLabel: string;
  updatedAt: string;
  mins: number | null;
  stale: boolean;
  refreshMinutes: number;
  demo: boolean;
  channel: Channel;
  onChannel: (c: Channel) => void;
  cat: string;
  onCat: (c: string) => void;
  categories: string[];
  actions?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="m-0 text-[22px] font-semibold tracking-tight">
          PnL en vivo · <span>{monthLabel}</span>
          <span
            className={`ml-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] align-[3px] text-xs font-semibold ${
              stale ? "bg-warnbg text-warn" : "bg-posbg text-pos"
            }`}
          >
            <i className={`h-[7px] w-[7px] rounded-full ${stale ? "bg-warn" : "animate-live bg-pos"}`} />
            {stale ? "Sin actualizar" : "En vivo"}
          </span>
          {demo ? (
            <span className="ml-2 rounded-full bg-warnbg px-2.5 py-[3px] align-[3px] text-xs font-semibold text-warn">
              DEMO
            </span>
          ) : null}
        </h1>
        <div className="mt-[3px] text-[13px] text-mut">
          Actualizado {updatedAt}
          {mins !== null ? ` (hace ${mins} min)` : ""} · se refresca cada {refreshMinutes} min
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <div role="group" aria-label="Canal" className="inline-flex overflow-hidden rounded-lg border border-line bg-card">
          {CHANNELS.map((c) => (
            <button
              key={c.v}
              type="button"
              aria-pressed={channel === c.v}
              onClick={() => onChannel(c.v)}
              className={`cursor-pointer border-0 px-3 py-1.5 text-[13px] ${
                channel === c.v ? "bg-navy font-semibold text-card" : "bg-transparent text-mut"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <select
          aria-label="Categoría"
          value={cat}
          onChange={(e) => onCat(e.target.value)}
          className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink"
        >
          <option value="all">Todas las categorías</option>
          {categories.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>
    </header>
  );
}
