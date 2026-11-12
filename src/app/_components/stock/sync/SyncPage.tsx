"use client";

import { useState } from "react";

import type { PushResult, SyncMode } from "~/lib/stock-contracts";
import { api } from "~/trpc/react";
import { Card, SectionLabel } from "../../dashboard/ui";
import { ConfirmDialog } from "./ConfirmDialog";
import { GoLiveWizard } from "./GoLiveWizard";
import {
  BLOCK_LABEL, classifyProducts, dryRunRows, filterLog, fmtDateTime, lastObserved, MODE_LABEL, NO_FILTERS,
  RESULT_LABEL, TRIGGER_LABEL, type LogFilters, type ProductReadiness,
} from "./logic";

const RESULT_TONE: Record<PushResult, string> = {
  ok: "bg-posbg text-pos", failed: "bg-negbg text-neg", skipped: "bg-warnbg text-warn", dry_run: "bg-bg text-mut",
};
const th = "whitespace-nowrap px-2 py-1.5 text-left text-xs font-semibold text-mut";
const td = "px-2 py-1.5 align-top";
const btn = "rounded-lg border border-line bg-card px-3 py-1.5 text-[13px] disabled:opacity-40";
const btnPrimary = "rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-card disabled:opacity-40";

export function SyncPage() {
  const utils = api.useUtils();
  const status = api.stockSync.status.useQuery();
  const log = api.stockSync.log.useQuery({ limit: 200 });
  const products = api.stockProducts.list.useQuery({});
  const alerts = api.stockAlerts.list.useQuery({});
  const counts = api.stockAlerts.counts.useQuery();
  const [filters, setFilters] = useState<LogFilters>(NO_FILTERS);
  const [wizard, setWizard] = useState<ProductReadiness[] | null>(null);
  const [backId, setBackId] = useState<{ ids: number[] | undefined; label: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [askCompare, setAskCompare] = useState(false);

  const refresh = () => Promise.all([utils.stockSync.invalidate(), utils.stockProducts.invalidate()]);
  const dryRun = api.stockSync.setDryRun.useMutation({
    onSuccess: refresh, onError: (e) => setActionError(e.message), onSettled: () => setBackId(null),
  });
  const compare = api.stockSync.compare.useMutation({ onSuccess: refresh, onError: (e) => setActionError(e.message) });

  const err = status.error ?? log.error ?? products.error;
  if (err) {
    return (
      <p role="alert" className="text-[13px] text-neg">
        {err.message === "ML_NOT_CONNECTED" ? "Conectá tu cuenta de Mercado Libre para usar la sincronización." : `No se pudo cargar la sincronización: ${err.message}`}
      </p>
    );
  }
  if (!status.data || !log.data || !products.data) return <p className="text-[13px] text-mut">Cargando…</p>;

  const cls = classifyProducts(products.data, alerts.data ?? [], status.data);
  const simulated = cls.ready.length + cls.blocked.length;
  const failed = status.data.filter((s) => s.status === "failed").length;
  const drift = status.data.filter((s) => s.status === "drift").length;
  const preview = dryRunRows(status.data);
  const rows = filterLog(log.data, filters);

  return (
    <div>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Card title="Modo"><div className="text-[13px]"><b>{simulated}</b> en simulación · <b>{cls.live.length}</b> en vivo</div></Card>
        <Card title="Última conciliación"><div className="text-[13px]">{fmtDateTime(lastObserved(status.data))}</div></Card>
        <Card title="Último webhook"><div className="text-[13px] text-mut" title="Todavía no hay un endpoint que lo informe">—</div></Card>
        <Card title="Pendientes"><div className="text-[13px]"><b>{drift}</b> diferencias · <b>{failed}</b> fallidos{counts.data ? ` · ${counts.data.open} alertas` : ""}</div></Card>
      </div>
      {actionError && <p role="alert" className="mt-2 text-[13px] text-neg">{actionError}</p>}

      <SectionLabel>Pasar a vivo</SectionLabel>
      <Card title="Productos" small="Nada se envía a Mercado Libre hasta que lo actives">
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" className={btnPrimary} disabled={cls.ready.length === 0} onClick={() => setWizard(cls.ready)}>
            Activar todos los listos ({cls.ready.length})
          </button>
          <button type="button" className={btn} disabled={compare.isPending} onClick={() => setAskCompare(true)}>Verificar con Mercado Libre</button>
          <button type="button" className={btn} disabled={cls.live.length === 0} onClick={() => setBackId({ ids: undefined, label: "todos los productos" })}>Volver todo a simulación</button>
        </div>
        <ul className="m-0 list-none p-0 text-[13px]">
          {[...cls.ready, ...cls.blocked].map((r) => (
            <li key={r.product.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2">
              <span>
                <b>{r.product.name}</b> <span className="text-mut">· stock {r.product.onHand} · {r.product.linkedListings} publ.</span>
                {r.blocked.length > 0 && (
                  <span className="ml-2 inline-block rounded-full bg-negbg px-2 text-xs text-neg">
                    Bloqueado: {r.blocked.map((b) => BLOCK_LABEL[b]).join(", ")}
                  </span>
                )}
              </span>
              <button type="button" className={btn} disabled={r.blocked.length > 0} onClick={() => setWizard([r])}>Activar en vivo</button>
            </li>
          ))}
          {cls.live.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2">
              <span><b>{p.name}</b> <span className="ml-1 inline-block rounded-full bg-posbg px-2 text-xs text-pos">En vivo</span></span>
              <button type="button" className={btn} onClick={() => setBackId({ ids: [p.id], label: p.name })}>Volver a simulación</button>
            </li>
          ))}
          {simulated + cls.live.length === 0 && <li className="py-2 text-mut">No hay productos vinculados todavía.</li>}
        </ul>
      </Card>

      <SectionLabel>Lo que se enviaría ahora</SectionLabel>
      <Card title="Simulación" small="Comparalo con Mercado Libre antes de activar">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead><tr><th className={th}>Publicación</th><th className={th}>Producto</th><th className={th}>Enviaríamos</th><th className={th}>ML tiene</th></tr></thead>
            <tbody>
              {preview.map((r) => (
                <tr key={r.linkId} className="border-t border-line">
                  <td className={td}>{r.itemId}{r.variationId !== null ? ` · var. ${r.variationId}` : ""}</td>
                  <td className={td}>{r.productNames.join(", ")}</td>
                  <td className={`${td} font-semibold`}>{r.desiredQty}</td>
                  <td className={`${td} ${r.differs ? "text-warn" : ""}`}>{r.lastObservedMlQty ?? "sin dato"}</td>
                </tr>
              ))}
              {preview.length === 0 && <tr><td colSpan={4} className={`${td} text-mut`}>Nada en simulación.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <SectionLabel>Registro de envíos</SectionLabel>
      <Card title="Envíos">
        <div className="mb-2 flex flex-wrap gap-2 text-[13px]">
          <select aria-label="Resultado" value={filters.result} onChange={(e) => setFilters({ ...filters, result: e.target.value as LogFilters["result"] })} className="rounded-md border border-line bg-bg px-2 py-1">
            <option value="all">Todos los resultados</option>
            {(Object.keys(RESULT_LABEL) as PushResult[]).map((k) => <option key={k} value={k}>{RESULT_LABEL[k]}</option>)}
          </select>
          <select aria-label="Modo" value={filters.mode} onChange={(e) => setFilters({ ...filters, mode: e.target.value as LogFilters["mode"] })} className="rounded-md border border-line bg-bg px-2 py-1">
            <option value="all">Todos los modos</option>
            {(Object.keys(MODE_LABEL) as SyncMode[]).map((k) => <option key={k} value={k}>{MODE_LABEL[k]}</option>)}
          </select>
          <input aria-label="Publicación" placeholder="Publicación (MLA…)" value={filters.listing} onChange={(e) => setFilters({ ...filters, listing: e.target.value })} className="rounded-md border border-line bg-bg px-2 py-1" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead><tr>
              <th className={th}>Fecha</th><th className={th}>Publicación</th><th className={th}>Variación</th><th className={th}>Pedida</th>
              <th className={th}>ML antes</th><th className={th}>Modo</th><th className={th}>Resultado</th><th className={th}>Origen</th><th className={th}>Error</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className={`${td} whitespace-nowrap`}>{fmtDateTime(r.createdAt)}</td>
                  <td className={td}>{r.itemId}</td>
                  <td className={td}>{r.variationId ?? "—"}</td>
                  <td className={td}>{r.requestedQty}</td>
                  <td className={td}>{r.previousMlQty ?? "—"}</td>
                  <td className={td}>{MODE_LABEL[r.mode]}</td>
                  <td className={td}><span className={`inline-block rounded-full px-1.5 text-xs font-semibold ${RESULT_TONE[r.result]}`}>{RESULT_LABEL[r.result]}</span></td>
                  <td className={td}>{TRIGGER_LABEL[r.triggerType]}</td>
                  <td className={`${td} text-neg`}>{r.error ?? ""}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={9} className={`${td} text-mut`}>Sin envíos para estos filtros.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      {wizard && <GoLiveWizard items={wizard} onClose={() => setWizard(null)} />}
      {backId && (
        <ConfirmDialog title="¿Volver a simulación?" confirmLabel="Volver a simulación" busy={dryRun.isPending}
          onConfirm={() => dryRun.mutate(backId.ids ? { productIds: backId.ids } : {})} onCancel={() => setBackId(null)}>
          Dejaremos de enviar stock a Mercado Libre para {backId.label}. Los envíos quedarán solo registrados.
        </ConfirmDialog>
      )}
      {askCompare && (
        <ConfirmDialog title="Verificar con Mercado Libre" confirmLabel="Verificar" busy={compare.isPending}
          onConfirm={() => { setAskCompare(false); compare.mutate(); }} onCancel={() => setAskCompare(false)}>
          Lee la cantidad actual de cada publicación vinculada y marca las diferencias. En los productos en vivo puede corregir Mercado Libre.
        </ConfirmDialog>
      )}
    </div>
  );
}
