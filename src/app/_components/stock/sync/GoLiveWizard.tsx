"use client";

import { useRef, useState } from "react";

import { api } from "~/trpc/react";
import { ConfirmDialog } from "./ConfirmDialog";
import { adjustPayloads, editsValid, goLivePayload, type ProductReadiness } from "./logic";

type Draft = { opening: string; reason: string; confirmed: boolean };

function ListingQty({ productId, ours }: { productId: number; ours: number }) {
  const q = api.stockSync.goLivePreview.useQuery({ productId });
  if (q.isLoading) return <p className="m-0 text-xs text-mut">Consultando Mercado Libre…</p>;
  if (q.error || !q.data) return <p className="m-0 text-xs text-neg">No se pudo leer Mercado Libre.</p>;
  return (
    <ul className="m-0 list-none p-0 text-xs">
      {q.data.listings.map((l) => (
        <li key={l.linkId} className="flex flex-wrap justify-between gap-2 border-t border-line py-1">
          <span className="text-mut">{l.itemId}{l.variationId !== null ? ` · var. ${l.variationId}` : ""}</span>
          <span>
            ML: <b>{l.mlQty ?? "sin dato"}</b> · Nuestro: <b>{ours}</b>
            {l.mlQty !== null && l.mlQty !== ours ? <span className="ml-1 text-warn">(difiere)</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Go-live wizard: 1) ML vs ours, 2) confirm / edit opening stock, 3) final confirm. */
export function GoLiveWizard({ items, onClose }: { items: ProductReadiness[]; onClose: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [drafts, setDrafts] = useState<Record<number, Draft>>(() =>
    Object.fromEntries(items.map((i) => [i.product.id, { opening: String(i.product.onHand), reason: "", confirmed: false }])));
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runKey = useRef(crypto.randomUUID()).current;
  const utils = api.useUtils();
  const adjust = api.stockProducts.adjustStock.useMutation();
  const goLive = api.stockSync.goLive.useMutation();

  const edits = items.map((i) => ({
    productId: i.product.id, ours: i.product.onHand, opening: Number(drafts[i.product.id]!.opening.replace(",", ".")),
    reason: drafts[i.product.id]!.reason,
  }));
  const allConfirmed = items.every((i) => drafts[i.product.id]!.confirmed);
  const step2Ok = allConfirmed && editsValid(edits);
  const listingCount = items.reduce((n, i) => n + i.product.linkedListings, 0);
  /** Editing a value un-confirms it; ticking the box only sets `confirmed`. */
  const edit = (id: number, p: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id]!, ...p, confirmed: false } }));
  const confirmOne = (id: number, confirmed: boolean) => setDrafts((d) => ({ ...d, [id]: { ...d[id]!, confirmed } }));

  async function run() {
    setBusy(true);
    setError(null);
    try {
      for (const a of adjustPayloads(edits, runKey)) await adjust.mutateAsync(a);
      await goLive.mutateAsync(goLivePayload(edits, runKey));
      await Promise.all([utils.stockSync.invalidate(), utils.stockProducts.invalidate(), utils.stockAlerts.invalidate()]);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
      setAsking(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label="Activar sincronización en vivo" className="my-6 w-full max-w-2xl rounded-xl border border-line bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="m-0 text-[15px] font-semibold">Pasar a vivo · paso {step} de 3</h3>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="text-lg leading-none text-mut">×</button>
        </div>

        {step === 1 && (
          <div>
            <p className="mt-0 text-[13px] text-mut">Cantidad disponible hoy en Mercado Libre junto a la nuestra.</p>
            {items.map((i) => (
              <div key={i.product.id} className="mb-3 rounded-lg border border-line p-3">
                <div className="mb-1 text-[13px] font-semibold">{i.product.name}</div>
                <ListingQty productId={i.product.id} ours={i.product.onHand} />
              </div>
            ))}
          </div>
        )}

        {step === 2 && (
          <div>
            <p className="mt-0 text-[13px] text-mut">Confirmá el stock inicial de cada producto o corregilo (el motivo es obligatorio si lo cambiás).</p>
            {items.map((i) => {
              const d = drafts[i.product.id]!;
              const e = edits.find((x) => x.productId === i.product.id)!;
              const changed = Number.isFinite(e.opening) && e.opening !== e.ours;
              return (
                <div key={i.product.id} className="mb-3 rounded-lg border border-line p-3 text-[13px]">
                  <div className="mb-2 font-semibold">{i.product.name} <span className="font-normal text-mut">(actual: {e.ours})</span></div>
                  <label className="mb-2 block text-xs text-mut">Stock inicial
                    <input inputMode="decimal" value={d.opening} onChange={(ev) => edit(i.product.id, { opening: ev.target.value })}
                      className="ml-2 w-24 rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink" />
                  </label>
                  {changed && (
                    <label className="mb-2 block text-xs text-mut">Motivo del ajuste
                      <input value={d.reason} onChange={(ev) => edit(i.product.id, { reason: ev.target.value })} maxLength={500}
                        className="mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink" />
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={d.confirmed} disabled={!Number.isFinite(e.opening) || (changed && !d.reason.trim())}
                      onChange={(ev) => confirmOne(i.product.id, ev.target.checked)} />
                    Confirmo que el stock inicial es correcto
                  </label>
                </div>
              );
            })}
          </div>
        )}

        {step === 3 && (
          <div className="text-[13px]">
            <p className="mt-0">Se enviará stock a <b>{listingCount}</b> {listingCount === 1 ? "publicación" : "publicaciones"} de {items.length} {items.length === 1 ? "producto" : "productos"} en Mercado Libre.</p>
            <p className="text-mut">Desde ahora cada venta, factura o ajuste actualizará la cantidad en Mercado Libre. Podés volver a simulación cuando quieras.</p>
            {error && <p role="alert" className="text-neg">No se pudo activar: {error}</p>}
          </div>
        )}

        <div className="mt-4 flex justify-between">
          <button type="button" disabled={step === 1} onClick={() => setStep((s) => (s - 1) as 1 | 2)} className="rounded-lg border border-line bg-card px-3 py-1.5 text-[13px] disabled:opacity-40">Atrás</button>
          {step < 3 ? (
            <button type="button" disabled={step === 2 && !step2Ok} onClick={() => setStep((s) => (s + 1) as 2 | 3)} className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-card disabled:opacity-40">Siguiente</button>
          ) : (
            <button type="button" onClick={() => setAsking(true)} className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-card">Activar en vivo</button>
          )}
        </div>
      </div>
      {asking && (
        <ConfirmDialog title="¿Activar la sincronización en vivo?" confirmLabel="Sí, enviar a Mercado Libre" busy={busy} onConfirm={() => void run()} onCancel={() => setAsking(false)}>
          Se enviará stock a {listingCount} {listingCount === 1 ? "publicación" : "publicaciones"}. Esta acción modifica Mercado Libre.
        </ConfirmDialog>
      )}
    </div>
  );
}
