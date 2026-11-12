"use client";

import Link from "next/link";
import { useState } from "react";

import { api } from "~/trpc/react";
import { cutoverIso, fmtCutoverDate, todayAr } from "./logic";

const btn = "rounded-lg border border-line bg-card px-3 py-1.5 text-[13px] disabled:opacity-50";
const btnPrimary = "rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-card disabled:opacity-50";

/**
 * The one-time "Iniciar migración": imports the P&L snapshot into the stock ledger. Three steps in one modal:
 * form (counts + date) → explicit confirmation → result.
 */
export function CutoverDialog({ onClose }: { onClose: () => void }) {
  const utils = api.useUtils();
  const status = api.stockCutover.status.useQuery();
  const [day, setDay] = useState(todayAr());
  const [confirming, setConfirming] = useState(false);
  const run = api.stockCutover.run.useMutation({
    onSuccess: () => void Promise.all([utils.stockCutover.invalidate(), utils.stockProducts.invalidate()]),
  });

  const s = status.data;
  const done = s?.cutoverAt != null;
  const iso = done ? s.cutoverAt : cutoverIso(day);
  const report = run.data;

  const start = () => { if (iso) run.mutate({ cutoverAt: iso }); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label="Iniciar migración" className="w-full max-w-md rounded-xl border border-line bg-card p-5 shadow-lg">
        <h3 className="m-0 mb-2 text-[15px] font-semibold">{done && !report ? "Migración inicial" : "Iniciar migración"}</h3>

        {report ? (
          <div className="text-[13px]">
            <p className="m-0 mb-2 font-semibold text-pos">
              {report.alreadyDone ? "Listo: se completó lo que faltaba." : "Listo: la migración se hizo."}
            </p>
            <ul className="m-0 mb-3 grid gap-1 pl-4">
              <li>Productos creados: <b>{report.productsCreated}</b>{report.productsExisting > 0 ? ` (${report.productsExisting} ya existían)` : ""}</li>
              <li>Publicaciones vinculadas: <b>{report.listingsLinked}</b></li>
              <li>
                Publicaciones sin vincular: <b>{report.listingsUnlinked}</b>
                {report.listingsUnlinked > 0 ? (
                  <> — resolvelas en <Link className="text-blue underline" href="/stock/alerts">Alertas</Link> o desde cada producto.</>
                ) : null}
              </li>
            </ul>
            <p className="m-0 mb-3 text-xs text-mut">Fecha de corte: {fmtCutoverDate(report.cutoverAt)}. Las ventas posteriores descuentan stock automáticamente.</p>
            <div className="flex justify-end"><button type="button" className={btnPrimary} onClick={onClose}>Cerrar</button></div>
          </div>
        ) : status.isLoading ? (
          <p className="text-[13px] text-mut">Cargando…</p>
        ) : status.error || !s ? (
          <div className="text-[13px]">
            <p role="alert" className="text-neg">No se pudo leer el estado de la migración.</p>
            <div className="flex justify-end gap-2">
              <button type="button" className={btn} onClick={() => void status.refetch()}>Reintentar</button>
              <button type="button" className={btn} onClick={onClose}>Cerrar</button>
            </div>
          </div>
        ) : s.snapshotProducts === 0 ? (
          <div className="text-[13px]">
            <p className="m-0 mb-3">No hay productos para importar. Subí primero el Excel del P&amp;L desde <Link className="text-blue underline" href="/stock/sync">Sincronización</Link>.</p>
            <div className="flex justify-end"><button type="button" className={btn} onClick={onClose}>Cerrar</button></div>
          </div>
        ) : confirming ? (
          <div className="text-[13px]">
            <p className="m-0 mb-3">
              Vas a crear <b>{s.productsToCreate}</b> {s.productsToCreate === 1 ? "producto" : "productos"} con su stock y costo del P&amp;L, con fecha de corte{" "}
              <b>{iso ? fmtCutoverDate(iso) : "—"}</b>, y vincular publicaciones por EAN. {done ? "" : "La fecha no se puede cambiar después."}
            </p>
            {run.error ? <p role="alert" className="m-0 mb-3 text-neg">{run.error.message}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={btn} disabled={run.isPending} onClick={() => { run.reset(); setConfirming(false); }}>Volver</button>
              <button type="button" className={btnPrimary} disabled={run.isPending || !iso} onClick={start}>
                {run.isPending ? "Migrando…" : "Sí, iniciar migración"}
              </button>
            </div>
          </div>
        ) : (
          <div className="text-[13px]">
            <p className="m-0 mb-2 text-mut">
              {done
                ? `La migración ya se hizo (corte ${fmtCutoverDate(s.cutoverAt!)}). Podés correrla de nuevo para crear los productos que falten: no toca los existentes.`
                : "Importa los productos del último Excel de P&L: crea cada producto con su stock y costo, y vincula las publicaciones de Mercado Libre por EAN."}
            </p>
            <ul className="m-0 mb-3 grid gap-1 pl-4" data-testid="cutover-counts">
              <li>Productos en el Excel: <b>{s.snapshotProducts}</b></li>
              <li>Se van a crear: <b>{s.productsToCreate}</b></li>
              <li>Ya existen (no se tocan): <b>{s.productsExisting}</b></li>
            </ul>
            {done ? null : (
              <label className="mb-3 grid gap-0.5 text-xs text-mut">
                Fecha de corte
                <input
                  type="date" value={day} max={todayAr()} onChange={(e) => setDay(e.target.value)}
                  className="h-8 w-44 rounded-lg border border-line bg-card px-2 text-[13px] text-ink"
                />
                <span>Las ventas desde esta fecha descuentan stock; las anteriores ya están reflejadas en el Excel.</span>
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={btn} onClick={onClose}>Cancelar</button>
              <button type="button" className={btnPrimary} disabled={!iso || s.productsToCreate === 0} onClick={() => setConfirming(true)}>
                {done ? "Completar faltantes" : "Iniciar migración"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
