"use client";

import Link from "next/link";

import type { AlertSummary } from "~/lib/stock-contracts";
import { api } from "~/trpc/react";

// `stockAlerts.counts` lands with S7; until then the router has no such procedure, so it is typed by hand.
// Remove this cast once S7 is merged.
type CountsApi = {
  counts: { useQuery: (input: undefined, opts: { retry: boolean; refetchInterval: number }) => { data?: AlertSummary } };
};

/** Compact "N alertas" link to the stock alerts tab. Renders nothing while the query fails, loads or is 0. */
export function AlertsBadge() {
  const { counts } = api.stockAlerts as unknown as CountsApi;
  const q = counts.useQuery(undefined, { retry: false, refetchInterval: 60_000 });
  const n = q.data?.total;
  if (!n || n < 1) return null;
  return (
    <Link
      href="/stock/alerts"
      className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-warnbg px-2.5 py-[3px] text-xs font-semibold text-warn no-underline"
    >
      <span className="inline-block h-2 w-2 rounded-full bg-warn" />
      {n} {n === 1 ? "alerta" : "alertas"}
    </Link>
  );
}
