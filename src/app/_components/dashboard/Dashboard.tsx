"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { DashboardData } from "~/lib/contracts";
import {
  accumSeries, categories as listCategories, categoryTable, computeDashboard, dailySeries,
  filterRows, footnote, freshness, salesFeed, topProducts, waterfall, type Channel,
} from "~/lib/dashboard-math";
import { AlertsBadge } from "../shell/AlertsBadge";
import { AccumChart, DailyChart, Waterfall } from "./charts";
import { Header } from "./Header";
import { KpiRow } from "./Kpi";
import { CategoryTable, SalesFeed, TopProducts } from "./tables";


const FILTER_KEY = "pnlf";

function readStorage<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/** Presentational dashboard: everything it shows comes from `data`. */
export function Dashboard({ data, demo = false, actions, banner }: {
  data: DashboardData;
  demo?: boolean;
  actions?: ReactNode;
  banner?: ReactNode;
  /** @deprecated unused since the alerts card moved to /stock/alerts; kept so the page container still compiles. */
  onMatchDecision?: (d: { itemId: string; ean: string; decision: "confirmed" | "rejected" }) => void;
  /** @deprecated see `onMatchDecision`. */
  matchPending?: boolean;
  /** @deprecated unused since the stock table left the dashboard. */
  marketSearch?: unknown;
}) {
  const [channel, setChannel] = useState<Channel>("all");
  const [cat, setCat] = useState("all");
  const [now, setNow] = useState<number | null>(null);

  const cats = useMemo(() => listCategories(data), [data]);

  // restore persisted filters after hydration
  useEffect(() => {
    const f = readStorage<{ canal?: Channel; cat?: string }>(FILTER_KEY);
    if (f?.canal && ["all", "ML", "VA"].includes(f.canal)) setChannel(f.canal);
    if (f?.cat) setCat(f.cat);
  }, []);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // a stored category that no longer exists falls back to "all"
  const effectiveCat = cat === "all" || cats.includes(cat) ? cat : "all";

  const changeChannel = (c: Channel) => {
    setChannel(c);
    writeStorage(FILTER_KEY, { canal: c, cat: effectiveCat });
  };
  const changeCat = (c: string) => {
    setCat(c);
    writeStorage(FILTER_KEY, { canal: channel, cat: c });
  };
  const view = useMemo(() => {
    const rows = filterRows(data, channel, effectiveCat);
    const d = computeDashboard(data, channel, effectiveCat);
    return {
      d,
      daily: dailySeries(data, rows, d.corte),
      wf: waterfall(d.mes),
      accum: accumSeries(data, rows, d.corte, d.full),
      cats: categoryTable(rows, d.corte),
      feed: salesFeed(rows),
      top: topProducts(rows, d.corte),
    };
  }, [data, channel, effectiveCat]);

  const fresh = now === null ? null : freshness(data, now);
  const { d } = view;

  return (
    <div className="mx-auto max-w-[1280px] px-4 pt-[22px] pb-12">
      <Header
        monthLabel={data.monthLabel}
        updatedAt={data.updatedAt}
        mins={fresh?.mins ?? null}
        stale={fresh?.stale ?? false}
        refreshMinutes={data.refreshMinutes}
        demo={demo}
        channel={channel}
        onChannel={changeChannel}
        cat={effectiveCat}
        onCat={changeCat}
        categories={cats}
        actions={actions}
      />
      {banner}
      <AlertsBadge />

      <KpiRow block={d.kHoy} />
      <KpiRow block={d.kMes} />

      <div className="mt-3 grid gap-3 min-[1000px]:grid-cols-[1.6fr_1fr]">
        <DailyChart points={view.daily} corte={d.corte} />
        <Waterfall steps={view.wf} venta={d.mes.venta} />
      </div>
      <div className="mt-3 grid gap-3 min-[1000px]:grid-cols-[1.6fr_1fr]">
        <AccumChart points={view.accum} corte={d.corte} prevLabel={data.comp.prevLabel}
          monthLabel={data.monthLabel} showPrev={d.full} />
        <CategoryTable rows={view.cats.rows} total={view.cats.total} />
      </div>
      <div className="mt-3 grid gap-3 min-[1000px]:grid-cols-2">
        <SalesFeed rows={view.feed} />
        <TopProducts rows={view.top} />
      </div>

      <footer className="mt-[22px] text-xs leading-relaxed text-mut">{footnote(data)}</footer>
    </div>
  );
}
