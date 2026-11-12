"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MarketPoint, MarketResearch } from "~/lib/market";

/** Max competitor listings the browser collector visits per run. */
export const COLLECT_LIMIT = 30;

export type CollectItem = { itemId: string; permalink: string };
export type CollectedItem = { itemId: string; sold: number; nickname: string | null };

/**
 * Margin of competitors worth visiting: new listings (when conditions are known), cheapest first, capped.
 * `onlyUnknown` keeps just the ones whose sales we haven't collected yet.
 */
export function pickCandidates(points: MarketPoint[], onlyUnknown: boolean): CollectItem[] {
  const others = points.filter((p) => !p.isOurs && p.permalink);
  const known = others.some((p) => p.condition != null);
  return others
    .filter((p) => !known || p.condition === "new")
    .sort((a, b) => a.price - b.price)
    .slice(0, COLLECT_LIMIT)
    .filter((p) => !onlyUnknown || p.soldQuantity == null)
    .map((p) => ({ itemId: p.itemId, permalink: p.permalink }));
}

type Inbound =
  | { source: "pnl-collector"; type: "hello" }
  | { source: "pnl-collector"; type: "progress"; done: number; total: number }
  | { source: "pnl-collector"; type: "results"; items: CollectedItem[] }
  | { source: "pnl-collector"; type: "done" };

const post = (msg: object) => window.postMessage({ source: "pnl-app", ...msg }, window.location.origin);

/**
 * Bridge to the userscript (public/pnl-market-collector.user.js) running in the user's own browser.
 * It reads "+N vendidos" from listing pages, which Mercado Libre only serves to real browsers.
 * Runs automatically once per fetched research; `reload` forces a re-read of every candidate.
 */
export function useSalesCollector(data: MarketResearch | null, onSales: (items: CollectedItem[]) => void) {
  const [installed, setInstalled] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const onSalesRef = useRef(onSales);
  onSalesRef.current = onSales;
  const autoRan = useRef<string | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as Inbound | undefined;
      if (e.source !== window || e.origin !== window.location.origin || m?.source !== "pnl-collector") return;
      if (m.type === "hello") setInstalled(true);
      else if (m.type === "progress") setProgress({ done: m.done, total: m.total });
      else if (m.type === "results") onSalesRef.current(m.items);
      else if (m.type === "done") setProgress(null);
    };
    window.addEventListener("message", onMessage);
    post({ type: "ping" }); // the script may have loaded before this page
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const start = useCallback((items: CollectItem[]) => {
    if (items.length === 0) return;
    setProgress({ done: 0, total: items.length });
    post({ type: "collect", items });
  }, []);

  useEffect(() => {
    if (!installed || !data || autoRan.current === data.fetchedAt) return;
    autoRan.current = data.fetchedAt;
    start(pickCandidates(data.points, true));
  }, [installed, data, start]);

  const reload = useCallback(() => {
    if (data) start(pickCandidates(data.points, false));
  }, [data, start]);

  return { installed, progress, reload };
}
