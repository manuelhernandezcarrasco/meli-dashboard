"use client";

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useState } from "react";

import type { RecentScan } from "~/server/api/routers/market-search";
import { api } from "~/trpc/react";
import { IndexResults, type IndexRow } from "./IndexResults";

export const INDEX_DEBOUNCE_MS = 250;

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function rowsFromRecent(recent: RecentScan[]): IndexRow[] {
  return recent.map((r) => ({
    key: r.catalogProductId,
    title: r.title,
    ean: r.ean,
    catalogProductId: r.catalogProductId,
    lastScanAt: r.lastScanAt,
  }));
}

export function MarketIndex() {
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), INDEX_DEBOUNCE_MS);
  const searching = q.length > 0;

  const recent = api.market.recent.useQuery();
  const search = api.market.searchOwnProducts.useQuery({ query: q }, { enabled: searching });

  const recentRows = rowsFromRecent(recent.data ?? []);
  const byCatalog = new Map(recentRows.map((r) => [r.catalogProductId, r]));

  const rows: IndexRow[] = searching
    ? (search.data ?? []).map((h) => {
        const known = h.catalogProductId ? byCatalog.get(h.catalogProductId) : undefined;
        return {
          key: h.itemId,
          title: h.title,
          ean: known?.ean ?? null,
          catalogProductId: h.catalogProductId,
          lastScanAt: known?.lastScanAt ?? null,
        };
      })
    : recentRows;

  const active = searching ? search : recent;
  const pending = text.trim() !== q || active.isLoading;

  return (
    <div className="mx-auto max-w-[1280px] px-4 pt-[22px] pb-12">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/" className="text-[13px] text-mut no-underline hover:underline">
            ← Volver al dashboard
          </Link>
          <h1 className="m-0 mt-1 text-[22px] font-semibold tracking-tight">Investigación de mercado</h1>
          <div className="mt-[3px] text-[13px] text-mut">
            Buscá uno de tus productos para comparar precios y ventas contra otros vendedores.
          </div>
        </div>
        <UserButton />
      </header>

      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Buscar mis productos por nombre…"
        aria-label="Buscar producto propio para investigar mercado"
        className="mb-4 w-full max-w-md rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-ink"
      />

      <IndexResults
        rows={rows}
        loading={pending}
        error={active.error ? active.error.message : null}
        onRetry={() => void active.refetch()}
        searching={searching}
      />
    </div>
  );
}
