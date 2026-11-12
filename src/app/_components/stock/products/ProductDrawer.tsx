"use client";

import { useRef, useState } from "react";

import type { ProductDetail } from "~/lib/stock-contracts";
import { api } from "~/trpc/react";
import {
  COST_REASON_LABEL, FILL_LABEL, fmtArs, fmtDateTime, fmtNum, fmtSigned, MOVEMENT_LABEL, STATE_LABEL, STATE_TONE, stockState,
} from "./format";

const TABS = ["Publicaciones", "Movimientos", "Historial de costo", "Ajuste"] as const;
type Tab = (typeof TABS)[number];
const inputCls = "h-8 w-full rounded-lg border border-line bg-card px-2 text-[13px] text-ink";
const btn = "h-8 rounded-lg border border-line px-3 text-[13px] disabled:opacity-50";
const btnPrimary = "h-8 rounded-lg bg-navy px-3 text-[13px] font-semibold text-white disabled:opacity-50";
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

export function ProductDrawer({ productId, onClose }: { productId: number; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("Publicaciones");
  const q = api.stockProducts.get.useQuery({ productId }, {});

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        role="dialog" aria-label="Detalle del producto" onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-[560px] flex-col overflow-y-auto border-l border-line bg-bg shadow-xl"
      >
        <div className="flex items-start justify-between gap-2 border-b border-line bg-card px-4 py-3">
          <h2 className="m-0 text-base font-semibold">{q.data?.product.name ?? "Producto"}</h2>
          <button type="button" aria-label="Cerrar" onClick={onClose} className="rounded px-2 text-lg leading-none text-mut">×</button>
        </div>

        {q.isLoading ? (
          <div data-testid="drawer-skeleton" className="grid gap-2 p-4">
            {Array.from({ length: 5 }, (_, i) => <div key={i} className="h-8 animate-pulse rounded-lg bg-line/60" />)}
          </div>
        ) : q.error || !q.data ? (
          <div className="p-4 text-[13px]">
            <p className="m-0 mb-3 text-neg">No se pudo cargar el producto.</p>
            <button type="button" className={btn} onClick={() => void q.refetch()}>Reintentar</button>
          </div>
        ) : (
          <div className="grid gap-4 p-4">
            <Summary d={q.data} />
            <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
              {TABS.map((t) => (
                <button
                  key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}
                  className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] ${tab === t ? "border-navy font-semibold" : "border-transparent text-mut"}`}
                >{t}</button>
              ))}
            </div>
            {tab === "Publicaciones" && <Listings d={q.data} />}
            {tab === "Movimientos" && <Movements d={q.data} />}
            {tab === "Historial de costo" && <CostHistory d={q.data} />}
            {tab === "Ajuste" && <Adjust productId={productId} onHand={q.data.product.onHand} />}
          </div>
        )}
      </aside>
    </div>
  );
}

type Detail = ProductDetail;

function Summary({ d }: { d: Detail }) {
  const p = d.product;
  const utils = api.useUtils();
  const [name, setName] = useState(p.name);
  const [category, setCategory] = useState(p.category);
  const [minUnits, setMinUnits] = useState(p.minUnits === null ? "" : String(p.minUnits));
  const [err, setErr] = useState<string | null>(null);
  const update = api.stockProducts.update.useMutation({
    onSuccess: () => utils.stockProducts.invalidate(),
    onError: (e) => setErr(e.message),
  });
  const st = stockState(p);
  const save = () => {
    setErr(null);
    const min = minUnits.trim() === "" ? null : Number(minUnits.replace(",", "."));
    if (!name.trim()) return setErr("El nombre es obligatorio.");
    if (min !== null && !(min >= 0)) return setErr("El mínimo debe ser un número positivo.");
    update.mutate({ productId: p.id, name: name.trim(), category: category.trim(), minUnits: min });
  };
  return (
    <section className="grid gap-3 rounded-xl border border-line bg-card p-3">
      <div className="grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4">
        <Stat label="En stock" value={fmtNum(p.onHand, 2)} />
        <Stat label="En reparación" value={fmtNum(p.inRepair, 2)} />
        <Stat label="Costo unit." value={fmtArs(p.unitCost)} />
        <div><div className="text-xs text-mut">Estado</div>
          <span className={`inline-block rounded-full px-2 text-xs leading-[19px] font-semibold ${STATE_TONE[st]}`}>{STATE_LABEL[st]}</span>
        </div>
      </div>
      <div className="text-xs text-mut">EAN {p.ean ?? "–"} · SKU {p.sku ?? "–"}</div>
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 grid gap-0.5 text-xs text-mut">Nombre<input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="grid gap-0.5 text-xs text-mut">Categoría<input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} /></label>
        <label className="grid gap-0.5 text-xs text-mut">Mínimo (unidades)<input className={inputCls} inputMode="decimal" value={minUnits} onChange={(e) => setMinUnits(e.target.value)} /></label>
      </div>
      {err && <p role="alert" className="m-0 text-[13px] text-neg">{err}</p>}
      <div><button type="button" className={btnPrimary} disabled={update.isPending} onClick={save}>Guardar cambios</button></div>
    </section>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div><div className="text-xs text-mut">{label}</div><div className="font-semibold">{value}</div></div>
);

function Listings({ d }: { d: Detail }) {
  const utils = api.useUtils();
  const [confirming, setConfirming] = useState<number | null>(null);
  const [linking, setLinking] = useState(false);
  const unlink = api.stockProducts.unlink.useMutation({ onSuccess: () => { setConfirming(null); return utils.stockProducts.invalidate(); } });
  return (
    <section className="grid gap-3">
      {d.listings.length === 0 && <p className="m-0 text-[13px] text-mut">Este producto no tiene publicaciones vinculadas.</p>}
      {d.listings.map((l) => (
        <div key={l.linkId} className="rounded-xl border border-line bg-card p-3 text-[13px]">
          <div className="font-semibold">{l.title ?? l.itemId}</div>
          <div className="text-xs text-mut">{l.itemId}{l.variationId ? ` · variación ${l.variationId}` : ""}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <span>Estado: {SYNC_LABEL[l.syncStatus]}</span>
            <span>Último enviado: {l.lastPushedQty ?? "–"}</span>
            <span>Último en ML: {l.lastObservedMlQty ?? "–"}</span>
          </div>
          <div className="mt-2">
            {confirming === l.linkId ? (
              <span className="flex gap-2">
                <button type="button" className={btnPrimary} disabled={unlink.isPending} onClick={() => unlink.mutate({ linkId: l.linkId })}>Confirmar desvinculación</button>
                <button type="button" className={btn} onClick={() => setConfirming(null)}>Cancelar</button>
              </span>
            ) : (
              <button type="button" className={btn} onClick={() => setConfirming(l.linkId)}>Desvincular</button>
            )}
          </div>
        </div>
      ))}
      {linking
        ? <LinkForm productId={d.product.id} onDone={() => setLinking(false)} />
        : <div><button type="button" className={btn} onClick={() => setLinking(true)}>Vincular publicación</button></div>}
    </section>
  );
}

const SYNC_LABEL = { never: "Sin enviar", in_sync: "Sincronizada", drift: "Desfasada", failed: "Con error" } as const;

function LinkForm({ productId, onDone }: { productId: number; onDone: () => void }) {
  const utils = api.useUtils();
  const unlinked = api.stockProducts.unlinkedListings.useQuery();
  const [sel, setSel] = useState("");
  const [itemId = "", varRaw = ""] = sel.split("|");
  const variationId = varRaw === "" ? null : Number(varRaw);
  const input = { marketplace: "mercadolibre" as const, itemId, variationId, components: [{ productId, quantity: 1 }] };
  const preview = api.stockProducts.previewLink.useQuery(input, { enabled: sel !== "" });
  const link = api.stockProducts.link.useMutation({
    onSuccess: async () => { await utils.stockProducts.invalidate(); onDone(); },
  });
  const fills = (preview.data ?? []).flatMap((p) => Object.entries(p.fills).filter(([, v]) => v !== undefined && v !== null && v !== ""));

  return (
    <div className="grid gap-2 rounded-xl border border-line bg-card p-3 text-[13px]">
      <label className="grid gap-0.5 text-xs text-mut">Publicación
        <select className={inputCls} value={sel} onChange={(e) => setSel(e.target.value)}>
          <option value="">Elegí una publicación sin vincular…</option>
          {(unlinked.data ?? []).map((u) => (
            <option key={`${u.itemId}|${u.variationId ?? ""}`} value={`${u.itemId}|${u.variationId ?? ""}`}>
              {u.itemId}{u.variationId ? ` (var. ${u.variationId})` : ""} · {u.title ?? "Sin título"}
            </option>
          ))}
        </select>
      </label>
      {sel !== "" && (
        preview.isLoading ? <p className="m-0 text-mut">Calculando…</p>
        : preview.error ? <p role="alert" className="m-0 text-neg">{preview.error.message}</p>
        : fills.length === 0 ? <p className="m-0 text-mut">El vínculo no completa ningún dato del producto.</p>
        : (
          <div>
            <p className="m-0 mb-1 text-mut">Al confirmar se completarán estos datos vacíos del producto:</p>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3">
              {fills.map(([k, v]) => (<div key={k} className="contents"><dt className="text-mut">{FILL_LABEL[k] ?? k}</dt><dd className="m-0">{String(v)}</dd></div>))}
            </dl>
          </div>
        )
      )}
      {link.error && <p role="alert" className="m-0 text-neg">{link.error.message}</p>}
      <div className="flex gap-2">
        <button type="button" className={btnPrimary} disabled={sel === "" || preview.isLoading || link.isPending}
          onClick={() => link.mutate({ ...input, fillMissing: true })}>Confirmar vínculo</button>
        <button type="button" className={btn} onClick={onDone}>Cancelar</button>
      </div>
    </div>
  );
}

function Movements({ d }: { d: Detail }) {
  if (d.recentMovements.length === 0) return <p className="m-0 text-[13px] text-mut">Sin movimientos todavía.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-card">
      <table className="tbl">
        <thead><tr><th>Fecha</th><th>Tipo</th><th className="ctr">Cant.</th><th className="ctr">Saldo</th><th>Referencia</th><th>Motivo</th></tr></thead>
        <tbody>
          {[...d.recentMovements].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id - a.id).map((m) => (
            <tr key={m.id}>
              <td>{fmtDateTime(m.occurredAt)}</td>
              <td>{MOVEMENT_LABEL[m.type]}</td>
              <td className={`ctr ${m.quantity < 0 ? "text-neg" : "text-pos"}`}>{fmtSigned(m.quantity)}</td>
              <td className="ctr">{fmtNum(m.onHandAfter, 2)}</td>
              <td>{m.refType ? `${m.refType} ${m.refId ?? ""}` : "–"}</td>
              <td>{m.reason ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CostHistory({ d }: { d: Detail }) {
  if (d.costHistory.length === 0) return <p className="m-0 text-[13px] text-mut">Sin historial de costo.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-card">
      <table className="tbl">
        <thead><tr><th>Desde</th><th className="ctr">Costo unit.</th><th className="ctr">Stock</th><th>Origen</th><th>Nota</th></tr></thead>
        <tbody>
          {d.costHistory.map((c) => (
            <tr key={c.id}>
              <td>{fmtDateTime(c.effectiveFrom)}</td>
              <td className="ctr">{fmtArs(c.unitCost)}</td>
              <td className="ctr">{fmtNum(c.onHandAtChange, 2)}</td>
              <td>{COST_REASON_LABEL[c.reason]}</td>
              <td>{c.note ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Adjust({ productId, onHand }: { productId: number; onHand: number }) {
  const utils = api.useUtils();
  const [mode, setMode] = useState<"delta" | "target">("delta");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const key = useRef(newKey());
  const adjust = api.stockProducts.adjustStock.useMutation({
    onSuccess: async () => { key.current = newKey(); setQty(""); setReason(""); setDone(true); await utils.stockProducts.invalidate(); },
    onError: (e) => setErr(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setDone(false);
    const n = Number(qty.replace(",", "."));
    if (qty.trim() === "" || !Number.isFinite(n)) return setErr("Ingresá una cantidad válida.");
    const delta = mode === "delta" ? n : n - onHand;
    if (delta === 0) return setErr("El ajuste no cambia el stock.");
    if (!reason.trim()) return setErr("Ingresá el motivo del ajuste.");
    adjust.mutate({ productId, delta, reason: reason.trim(), idempotencyKey: key.current });
  };

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-xl border border-line bg-card p-3 text-[13px]">
      <div className="flex gap-4">
        <label className="flex items-center gap-1"><input type="radio" name="mode" checked={mode === "delta"} onChange={() => setMode("delta")} />Sumar / restar</label>
        <label className="flex items-center gap-1"><input type="radio" name="mode" checked={mode === "target"} onChange={() => setMode("target")} />Dejar en</label>
      </div>
      <label className="grid gap-0.5 text-xs text-mut">{mode === "delta" ? "Cantidad (+/−)" : "Cantidad"}
        <input className={inputCls} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      <label className="grid gap-0.5 text-xs text-mut">Motivo
        <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {err && <p role="alert" className="m-0 text-neg">{err}</p>}
      {done && <p role="status" className="m-0 text-pos">Ajuste aplicado.</p>}
      <div><button type="submit" className={btnPrimary} disabled={adjust.isPending}>Aplicar ajuste</button></div>
    </form>
  );
}
