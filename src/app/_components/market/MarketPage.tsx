"use client";

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useState } from "react";

import type { MarketResearch, MarketState } from "~/lib/market";
import { api } from "~/trpc/react";
import { MarketChart } from "./MarketChart";
import { useMarketResearch } from "./useMarketResearch";
import { useSalesCollector } from "./useSalesCollector";

function MarketSkeleton() {
  return (
    <div className="h-[420px] animate-pulse rounded-xl border border-line bg-card" aria-busy="true" role="status" aria-label="Cargando" />
  );
}

function LinkMercadoLibre() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="m-0 text-[22px] font-semibold tracking-tight">Vinculá tu cuenta de Mercado Libre</h1>
      <p className="m-0 text-[13px] text-mut">Necesitamos acceso de lectura para investigar el mercado.</p>
      <a href="/api/auth/login" className="rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-card no-underline">
        Vincular Mercado Libre
      </a>
    </main>
  );
}

export function minutesAgo(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

function dataOf(s: MarketState | undefined): MarketResearch | null {
  return s && s.status !== "none" ? s.data : null;
}

export function MarketPage({ catalogProductId }: { catalogProductId: string }) {
  const conn = api.dashboard.connection.useQuery();
  if (conn.data && !conn.data.linked) return <LinkMercadoLibre />;
  return <MarketResearchView catalogProductId={catalogProductId} />;
}

function MarketResearchView({ catalogProductId }: { catalogProductId: string }) {
  const { state, error, retry, retrying } = useMarketResearch(catalogProductId);

  // re-render each minute so "hace X min" stays current while the page is open
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const data = dataOf(state);
  const utils = api.useUtils();
  const submit = api.market.submitSales.useMutation({
    onSuccess: () => void utils.market.get.invalidate({ catalogProductId }),
  });
  const collector = useSalesCollector(data, (items) => submit.mutate({ items }));
  const running = state?.status === "running";
  const failed = state?.status === "failed" ? state : null;
  const unknownCatalog = state?.status === "ready" && state.data.points.length === 0 && !state.data.catalogTitle;

  return (
    <div className="mx-auto max-w-[1280px] px-4 pt-[22px] pb-12">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/" className="text-[13px] text-mut no-underline hover:underline">
            ← Volver al dashboard
          </Link>
          <h1 className="m-0 mt-1 text-[22px] font-semibold tracking-tight">
            {data?.catalogTitle ? data.catalogTitle : "Investigación de mercado"}
          </h1>
          <div className="mt-[3px] flex items-center gap-2 text-[13px] text-mut">
            {data ? <span>Actualizado hace {minutesAgo(data.fetchedAt, now)} min</span> : null}
            {running && data ? (
              <span role="status" className="inline-flex items-center gap-1.5">
                <i className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-ink" />
                Actualizando…
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-mut" data-testid="sales-collector">
            {collector.installed ? (
              <>
                <button
                  type="button"
                  onClick={collector.reload}
                  disabled={!data || collector.progress != null}
                  className="cursor-pointer rounded-lg border border-line bg-card px-3 py-1 text-[13px] font-semibold text-ink disabled:cursor-default disabled:opacity-60"
                >
                  Recargar ventas
                </button>
                {collector.progress ? (
                  <span role="status">Leyendo ventas {collector.progress.done}/{collector.progress.total}…</span>
                ) : null}
              </>
            ) : (
              <span>
                Ventas de otros vendedores: <a href="/pnl-market-collector.user.js" className="text-blue">instalá el colector</a> (Tampermonkey) para verlas.
              </span>
            )}
          </div>
        </div>
        <UserButton />
      </header>

      {failed ? (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-neg bg-negbg px-4 py-2.5 text-[13px] text-neg">
          <span>No se pudo actualizar el mercado: {failed.error}.{data ? " Se muestran los últimos datos disponibles." : ""}</span>
          <button
            type="button"
            onClick={retry}
            disabled={retrying}
            className="cursor-pointer rounded-lg border border-neg bg-card px-3 py-1 text-[13px] font-semibold text-neg disabled:opacity-60"
          >
            Reintentar
          </button>
        </div>
      ) : null}
      {error && !failed ? (
        <div role="alert" className="mb-3 rounded-xl border border-neg bg-negbg px-4 py-2.5 text-[13px] text-neg">
          No se pudo consultar el estado: {error}.{data ? " Se muestran los últimos datos disponibles." : ""}
        </div>
      ) : null}

      {unknownCatalog ? (
        <div className="rounded-xl border border-line bg-card p-8 text-center text-[13px] text-mut">
          No encontramos este producto de catálogo en Mercado Libre.
        </div>
      ) : data ? (
        <MarketChart data={data} />
      ) : failed || error ? null : (
        <MarketSkeleton />
      )}
    </div>
  );
}
