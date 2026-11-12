"use client";

import { useEffect, useState } from "react";

import type { ProductFill } from "~/lib/stock-contracts";
import { api } from "~/trpc/react";
import type { ReviewLine } from "./types";

type Mode = "match" | "create" | null;

const FILL_LABELS: Record<keyof ProductFill, string> = { ean: "EAN", sku: "SKU", model: "Modelo", category: "Categoría" };

/** Fields a manual match would fill: only those the product lacks and the invoice line has. Never overwrites. */
export function fillPreview(line: ReviewLine, p: { ean: string | null; sku: string | null }): string[] {
  const out: string[] = [];
  if (!p.ean && line.ean) out.push(`${FILL_LABELS.ean}: ${line.ean}`);
  if (!p.sku && line.supplierCode) out.push(`${FILL_LABELS.sku}: ${line.supplierCode}`);
  return out;
}

export interface CreateDraft {
  ean: string | null;
  sku: string | null;
  name: string;
  model: string;
  category: string;
}

export function LineResolver({ line, disabled, onMatch, onCreate, onSkip }: {
  line: ReviewLine;
  disabled: boolean;
  onMatch: (productId: number) => void;
  onCreate: (p: CreateDraft) => void;
  onSkip: () => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [draft, setDraft] = useState<CreateDraft>({
    ean: line.ean,
    sku: line.supplierCode || null,
    name: line.description,
    model: "",
    category: "",
  });
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const search = api.stockProducts.list.useQuery({ query: debounced, includeArchived: false }, { enabled: mode === "match" && debounced.length >= 2 });
  const results = (mode === "match" && debounced.length >= 2 ? search.data : undefined) ?? [];
  const eanOk = draft.ean == null || /^\d{13}$/.test(draft.ean);

  const btn = "cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs disabled:opacity-60";
  return (
    <div className="min-w-0 text-xs">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={btn} disabled={disabled} onClick={() => setMode(mode === "match" ? null : "match")}>
          Vincular con producto existente
        </button>
        <button type="button" className={btn} disabled={disabled} onClick={() => setMode(mode === "create" ? null : "create")}>
          Crear producto
        </button>
        <button type="button" className={`${btn} text-neg`} disabled={disabled} onClick={onSkip}>
          Omitir línea
        </button>
      </div>

      {mode === "match" ? (
        <div className="mt-2 rounded-lg border border-line bg-bg p-2">
          {line.suggestions?.length ? (
            <div className="mb-2">
              <div className="mb-1 text-mut">Sugeridos</div>
              <ul className="m-0 list-none p-0">
                {line.suggestions.map((s) => (
                  <li key={s.productId} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="min-w-0 truncate">{s.name}</span>
                    <button type="button" className={btn} disabled={disabled} onClick={() => onMatch(s.productId)}>
                      Vincular
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <input
            type="search"
            aria-label="Buscar producto"
            placeholder="Buscar por nombre, EAN o SKU…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full rounded-lg border border-line bg-card px-2 py-1.5 text-[13px]"
          />
          {search.isLoading && debounced.length >= 2 ? <p className="m-0 mt-1 text-mut">Buscando…</p> : null}
          {debounced.length >= 2 && !search.isLoading && results.length === 0 ? (
            <p className="m-0 mt-1 text-mut">Sin resultados.</p>
          ) : null}
          <ul className="m-0 mt-1 list-none p-0">
            {results.slice(0, 8).map((p) => {
              const fills = fillPreview(line, p);
              return (
                <li key={p.id} className="flex items-start justify-between gap-2 border-t border-line py-1.5 first:border-t-0">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="text-mut">
                      {p.ean ?? "sin EAN"} · stock {p.onHand}
                    </div>
                    <div className="text-mut">
                      {fills.length ? `Se completará: ${fills.join(" · ")}` : "No se completa ningún dato (no se pisa nada)."}
                    </div>
                  </div>
                  <button type="button" className={btn} disabled={disabled} onClick={() => onMatch(p.id)}>
                    Vincular
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {mode === "create" ? (
        <form
          className="mt-2 grid gap-2 rounded-lg border border-line bg-bg p-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (eanOk && draft.name.trim()) onCreate({ ...draft, name: draft.name.trim() });
          }}
        >
          <label className="sm:col-span-2">
            <span className="text-mut">Nombre</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-full rounded-lg border border-line bg-card px-2 py-1.5 text-[13px]" />
          </label>
          <label>
            <span className="text-mut">EAN</span>
            <input value={draft.ean ?? ""} onChange={(e) => setDraft({ ...draft, ean: e.target.value.trim() || null })} className="w-full rounded-lg border border-line bg-card px-2 py-1.5 text-[13px]" />
            {!eanOk ? <span className="text-neg">Tiene que tener 13 dígitos.</span> : null}
          </label>
          <label>
            <span className="text-mut">SKU</span>
            <input value={draft.sku ?? ""} onChange={(e) => setDraft({ ...draft, sku: e.target.value.trim() || null })} className="w-full rounded-lg border border-line bg-card px-2 py-1.5 text-[13px]" />
          </label>
          <label>
            <span className="text-mut">Modelo</span>
            <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} className="w-full rounded-lg border border-line bg-card px-2 py-1.5 text-[13px]" />
          </label>
          <label>
            <span className="text-mut">Categoría</span>
            <input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className="w-full rounded-lg border border-line bg-card px-2 py-1.5 text-[13px]" />
          </label>
          <div className="sm:col-span-2">
            <button type="submit" disabled={disabled || !eanOk || !draft.name.trim()} className="cursor-pointer rounded-lg border-0 bg-navy px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60">
              Crear y vincular
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
