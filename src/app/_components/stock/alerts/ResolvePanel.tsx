"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import type { AlertRow } from "~/lib/stock-contracts";
import { api } from "~/trpc/react";
import {
  checkAdjust, checkCost, checkNewProduct, checkQuantity, linkInput, productHref,
} from "./logic";
import { Btn, Field, FormError, TextInput } from "./ui";

export interface PanelProps {
  alert: AlertRow;
  /** Optimistic resolve / acknowledge from the list. Rejects (after rolling back) when the server fails. */
  resolve: (resolution: string) => Promise<void>;
  acknowledge: () => Promise<void>;
  /** Refresh anything that depends on what the form changed (product lists, counts). */
  refresh: () => Promise<void>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : "No se pudo completar la acción");
const newKey = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()));

/** Hook that runs a submit handler, tracking pending + error state. */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (f: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await f(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

// `stockProducts.setCost` is named by S7's form spec but is not in the merged router yet (reported in the PR).
type SetCostApi = {
  setCost: { useMutation: () => { mutateAsync: (i: { productId: number; unitCost: number; note?: string }) => Promise<unknown> } };
};

function Block({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3">{children}</div>;
}

/* ---------- unmatched_listing / unmatched_sale ---------- */

type MatchMode = "link" | "create" | "ignore";

function MatchPanel({ alert, resolve, refresh }: PanelProps) {
  const itemId = alert.itemId ?? "";
  const [mode, setMode] = useState<MatchMode>("link");
  const { busy, error, setError, run } = useSubmit();
  const listings = api.stockProducts.unlinkedListings.useQuery();
  const listing = listings.data?.find((l) => l.itemId === itemId);
  const variationId = listing?.variationId ?? null;

  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<{ id: number; name: string } | null>(null);
  const [qty, setQty] = useState("1");
  const found = api.stockProducts.list.useQuery({ query: search }, { enabled: search.trim().length >= 2 && !picked });
  const q = checkQuantity(qty);
  const preview = api.stockProducts.previewLink.useQuery(
    linkInput(itemId, variationId, picked?.id ?? 1, q.ok ? q.value : 1),
    { enabled: !!picked && q.ok && itemId !== "" },
  );
  const link = api.stockProducts.link.useMutation();
  const create = api.stockProducts.create.useMutation();

  const [name, setName] = useState<string | null>(null);
  const [gtin, setGtin] = useState<string | null>(null);
  const [sku, setSku] = useState<string | null>(null);
  const nameV = name ?? listing?.title ?? alert.title;
  const gtinV = gtin ?? listing?.gtin ?? "";
  const skuV = sku ?? listing?.skus[0] ?? "";

  const doLink = () => run(async () => {
    if (!picked) throw new Error("Elegí un producto");
    if (!q.ok) throw new Error(q.error);
    await link.mutateAsync({ ...linkInput(itemId, variationId, picked.id, q.value), fillMissing: true });
    await refresh();
  });
  const doCreate = () => run(async () => {
    const c = checkNewProduct({ name: nameV, gtin: gtinV, sku: skuV });
    if (!c.ok) throw new Error(c.error);
    const { productId } = await create.mutateAsync({ ...c.value, model: "", category: "", minUnits: null });
    await link.mutateAsync({ ...linkInput(itemId, variationId, productId, 1), fillMissing: true });
    await refresh();
  });

  const fills = (preview.data ?? []).flatMap((p) =>
    Object.entries(p.fills as Record<string, unknown>).filter(([, v]) => v != null && v !== ""));

  return (
    <Block>
      <div role="tablist" className="flex flex-wrap gap-1.5">
        {([["link", "Vincular con producto existente"], ["create", "Crear producto"], ["ignore", "Ignorar"]] as const).map(([m, label]) => (
          <button
            key={m} type="button" role="tab" aria-selected={mode === m}
            onClick={() => { setMode(m); setError(""); }}
            className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${mode === m ? "border-navy bg-navy text-card" : "border-line bg-card text-ink"}`}
          >{label}</button>
        ))}
      </div>

      {mode === "link" && (
        <>
          {picked ? (
            <div className="flex items-center gap-2 text-[13px]">
              <strong>{picked.name}</strong>
              <Btn onClick={() => setPicked(null)}>Cambiar</Btn>
            </div>
          ) : (
            <Field label="Buscar producto">
              <TextInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nombre, EAN o SKU" />
            </Field>
          )}
          {!picked && found.data && (
            <ul className="m-0 flex max-h-44 list-none flex-col gap-1 overflow-y-auto p-0">
              {found.data.length === 0 ? <li className="text-xs text-mut">Sin resultados</li> : null}
              {found.data.slice(0, 20).map((p) => (
                <li key={p.id}>
                  <button
                    type="button" onClick={() => setPicked({ id: p.id, name: p.name })}
                    className="w-full cursor-pointer rounded-md border border-line bg-card px-2 py-1.5 text-left text-[13px] hover:border-blue"
                  >{p.name}<span className="ml-1.5 text-xs text-mut">{p.ean ?? p.sku ?? ""}</span></button>
                </li>
              ))}
            </ul>
          )}
          {picked && (
            <>
              <Field label="Unidades por venta"><TextInput inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
              <div className="rounded-md bg-bg px-2.5 py-2 text-xs text-mut">
                <div className="mb-1 font-semibold text-ink">Se completarán en el producto</div>
                {preview.isLoading ? "Calculando…" : fills.length === 0 ? "Nada: el producto ya tiene esos datos." : (
                  <ul className="m-0 list-none p-0">{fills.map(([k, v]) => <li key={k}>{k}: {String(v)}</li>)}</ul>
                )}
              </div>
            </>
          )}
          <div><Btn kind="primary" disabled={busy || !picked} onClick={doLink}>Vincular</Btn></div>
        </>
      )}

      {mode === "create" && (
        <>
          <Field label="Nombre"><TextInput value={nameV} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="GTIN / EAN (13 dígitos)"><TextInput inputMode="numeric" value={gtinV} onChange={(e) => setGtin(e.target.value)} /></Field>
            <Field label="SKU"><TextInput value={skuV} onChange={(e) => setSku(e.target.value)} /></Field>
          </div>
          <div><Btn kind="primary" disabled={busy} onClick={doCreate}>Crear y vincular</Btn></div>
        </>
      )}

      {mode === "ignore" && (
        <>
          <p className="m-0 text-xs text-mut">La alerta se marca como resuelta sin vincular. Si la publicación sigue sin vínculo, puede volver a aparecer.</p>
          <div><Btn disabled={busy} onClick={() => run(() => resolve("ignorada"))}>Ignorar</Btn></div>
        </>
      )}
      <FormError>{error}</FormError>
    </Block>
  );
}

/* ---------- link_cost_review / missing_cost ---------- */

function CostPanel({ alert, resolve, refresh }: PanelProps) {
  const review = alert.type === "link_cost_review";
  const { busy, error, run } = useSubmit();
  const [editing, setEditing] = useState(!review);
  const [cost, setCost] = useState(alert.amount != null ? String(alert.amount) : "");
  const [note, setNote] = useState("");
  const { setCost: setCostM } = api.stockProducts as unknown as SetCostApi;
  const m = setCostM.useMutation();

  const save = () => run(async () => {
    const c = checkCost(cost);
    if (!c.ok) throw new Error(c.error);
    if (alert.productId == null) throw new Error("La alerta no tiene producto asociado");
    await m.mutateAsync({ productId: alert.productId, unitCost: c.value, ...(note.trim() ? { note: note.trim() } : {}) });
    await resolve(review ? `costo editado: ${c.value}` : `costo cargado: ${c.value}`);
    await refresh();
  });

  return (
    <Block>
      {review && (
        <div className="rounded-md bg-bg px-2.5 py-2 text-[13px]">
          Costo calculado: <strong>{alert.amount != null ? `$ ${alert.amount.toLocaleString("es-AR")}` : "—"}</strong>
          <br />
          <span className="text-xs text-mut">
            {alert.quantity ?? 0} venta(s) pendientes se aplicarán con este costo recién cuando lo aceptes o lo edites.
          </span>
        </div>
      )}
      {editing ? (
        <>
          <Field label="Costo unitario (ARS)"><TextInput inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
          <Field label="Nota (opcional)"><TextInput value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {review && !editing && (
          <>
            <Btn kind="primary" disabled={busy} onClick={() => run(async () => { await resolve("costo aceptado"); await refresh(); })}>Aceptar</Btn>
            <Btn disabled={busy} onClick={() => setEditing(true)}>Editar costo</Btn>
          </>
        )}
        {editing && <Btn kind="primary" disabled={busy} onClick={save}>{review ? "Guardar costo y aplicar" : "Guardar costo"}</Btn>}
      </div>
      <FormError>{error}</FormError>
    </Block>
  );
}

/* ---------- suggested_match / auto_match ---------- */

function MatchDecisionPanel({ alert, refresh }: PanelProps) {
  const { busy, error, run } = useSubmit();
  const m = api.stockAlerts.decideMatch.useMutation();
  const auto = alert.type === "auto_match";
  const decide = (decision: "confirm" | "reject" | "undo") => run(async () => {
    await m.mutateAsync({ id: alert.id, decision });
    await refresh();
  });
  return (
    <Block>
      <div className="flex flex-wrap gap-2">
        <Btn kind="primary" disabled={busy} onClick={() => decide("confirm")}>Confirmar</Btn>
        {auto
          ? <Btn kind="danger" disabled={busy} onClick={() => decide("undo")}>Deshacer</Btn>
          : <Btn kind="danger" disabled={busy} onClick={() => decide("reject")}>Rechazar</Btn>}
      </div>
      <FormError>{error}</FormError>
    </Block>
  );
}

/* ---------- negative_stock ---------- */

function AdjustForm({ alert, resolve, refresh, label }: PanelProps & { label: string }) {
  const { busy, error, run } = useSubmit();
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [key] = useState(newKey);
  const m = api.stockProducts.adjustStock.useMutation();
  const submit = () => run(async () => {
    const c = checkAdjust(delta, reason);
    if (!c.ok) throw new Error(c.error);
    if (alert.productId == null) throw new Error("La alerta no tiene producto asociado");
    await m.mutateAsync({ productId: alert.productId, delta: c.value.delta, reason: c.value.reason, idempotencyKey: `alert:${alert.id}:${key}` });
    await resolve(`ajustado ${c.value.delta > 0 ? "+" : ""}${c.value.delta}: ${c.value.reason}`);
    await refresh();
  });
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
        <Field label="Ajuste (± unidades)"><TextInput inputMode="decimal" value={delta} onChange={(e) => setDelta(e.target.value)} /></Field>
        <Field label="Motivo (obligatorio)"><TextInput value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
      <div><Btn kind="primary" disabled={busy} onClick={submit}>{label}</Btn></div>
      <FormError>{error}</FormError>
    </>
  );
}

function NegativeStockPanel(p: PanelProps) {
  const { busy, error, run } = useSubmit();
  return (
    <Block>
      <p className="m-0 text-xs text-mut">
        Un stock negativo suele significar que la migración o el conteo inicial no terminó (ventas anteriores al stock cargado).
        Mercado Libre solo recibe 0 mientras tanto.
      </p>
      <AdjustForm {...p} label="Ajustar stock" />
      <div><Btn disabled={busy} onClick={() => run(p.acknowledge)}>Reconocer</Btn></div>
      <FormError>{error}</FormError>
    </Block>
  );
}

/* ---------- push_failed / stock_drift ---------- */

function PushPanel(p: PanelProps) {
  const { alert, resolve, refresh } = p;
  const { busy, error, run } = useSubmit();
  const status = api.stockSync.status.useQuery();
  const row = status.data?.find((s) => s.itemId === alert.itemId);
  const product = api.stockProducts.get.useQuery({ productId: alert.productId ?? 1 }, { enabled: alert.productId != null });
  const compare = api.stockSync.compare.useMutation();
  const adjust = api.stockProducts.adjustStock.useMutation();
  const [key] = useState(newKey);

  const ours = product.data?.product.onHand ?? null;
  const ml = row?.lastObservedMlQty ?? null;

  const acceptMl = () => run(async () => {
    if (alert.productId == null || ours == null || ml == null) throw new Error("Faltan datos para comparar con Mercado Libre");
    const delta = ml - ours;
    if (delta !== 0) {
      await adjust.mutateAsync({
        productId: alert.productId, delta, reason: `Aceptar valor de Mercado Libre (${ml})`, idempotencyKey: `alert:${alert.id}:${key}`,
      });
    }
    await resolve(`aceptado valor de ML: ${ml}`);
    await refresh();
  });

  return (
    <Block>
      <div className="grid grid-cols-2 gap-3 rounded-md bg-bg px-2.5 py-2 text-[13px]">
        <div><div className="text-xs text-mut">Nuestro stock</div><strong>{ours ?? "—"}</strong></div>
        <div><div className="text-xs text-mut">Mercado Libre</div><strong>{ml ?? "—"}</strong></div>
        {row?.lastError ? <div className="col-span-2 text-xs text-neg">{row.lastError}</div> : null}
      </div>
      <p className="m-0 text-xs text-mut">Nada se corrige solo: elegí qué valor queda.</p>
      <div className="flex flex-wrap gap-2">
        <Btn
          disabled={busy}
          title="Vuelve a leer Mercado Libre y compara"
          onClick={() => run(async () => { await compare.mutateAsync(); await refresh(); })}
        >Reintentar envío</Btn>
        <Btn kind="primary" disabled={busy || ml == null || ours == null} onClick={acceptMl}>Aceptar valor de ML</Btn>
      </div>
      <FormError>{error}</FormError>
    </Block>
  );
}

/* ---------- low_stock / out_of_stock / margin_drop (and any other) ---------- */

function LinkOnlyPanel({ alert, acknowledge, resolve }: PanelProps) {
  const { busy, error, run } = useSubmit();
  return (
    <Block>
      {alert.productId != null && (
        <Link href={productHref(alert.productId)} className="text-[13px] text-blue">Abrir el producto</Link>
      )}
      <div className="flex flex-wrap gap-2">
        <Btn disabled={busy} onClick={() => run(acknowledge)}>Reconocer</Btn>
        <Btn kind="primary" disabled={busy} onClick={() => run(() => resolve("resuelta manualmente"))}>Marcar como resuelta</Btn>
      </div>
      <FormError>{error}</FormError>
    </Block>
  );
}

export function ResolvePanel(p: PanelProps) {
  switch (p.alert.type) {
    case "unmatched_listing":
    case "unmatched_sale": return <MatchPanel {...p} />;
    case "link_cost_review":
    case "missing_cost": return <CostPanel {...p} />;
    case "suggested_match":
    case "auto_match": return <MatchDecisionPanel {...p} />;
    case "negative_stock": return <NegativeStockPanel {...p} />;
    case "push_failed":
    case "stock_drift": return <PushPanel {...p} />;
    default: return <LinkOnlyPanel {...p} />;
  }
}
