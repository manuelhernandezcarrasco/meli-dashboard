"use client";

import { useEffect, useMemo, useState } from "react";

import type { ProductRow, SyncMode } from "~/lib/stock-contracts";
import { api } from "~/trpc/react";
import { SortTh, useSort } from "../../dashboard/sort";
import { CutoverDialog } from "../cutover/CutoverDialog";
import { CreateProductModal } from "./CreateProductModal";
import { ProductDrawer } from "./ProductDrawer";
import {
  breakDate, FORECAST_TIP, fmtArs, fmtNum, STATE_LABEL, STATE_TONE, stockState, type StockState,
} from "./format";

export const SEARCH_DEBOUNCE_MS = 250;
export const PAGE_SIZE = 50;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const Chip = ({ tone, children }: { tone: string; children: string }) => (
  <span className={`inline-block rounded-full px-2 text-xs leading-[19px] font-semibold whitespace-nowrap ${tone}`}>{children}</span>
);

const selectCls = "h-8 rounded-lg border border-line bg-card px-2 text-[13px] text-ink";

export function ProductsPage() {
  const [text, setText] = useState("");
  const query = useDebounced(text.trim(), SEARCH_DEBOUNCE_MS);
  const [state, setState] = useState<StockState | "all">("all");
  const [category, setCategory] = useState("");
  const [mode, setMode] = useState<SyncMode | "all">("all");
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [migrating, setMigrating] = useState(false);

  const list = api.stockProducts.list.useQuery({ ...(query ? { query } : {}) });
  const all = useMemo(() => list.data ?? [], [list.data]);
  const categories = useMemo(() => [...new Set(all.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es")), [all]);

  const filtered = useMemo(
    () => all.filter((p) =>
      (state === "all" || stockState(p) === state) && (!category || p.category === category) && (mode === "all" || p.syncMode === mode)),
    [all, state, category, mode],
  );
  const { rows, sort, toggle } = useSort<ProductRow>(filtered, {
    name: (r) => r.name, ean: (r) => r.ean, sku: (r) => r.sku, category: (r) => r.category, onHand: (r) => r.onHand,
    inRepair: (r) => r.inRepair, unitCost: (r) => r.unitCost, coverage: (r) => r.coverageDays,
    linked: (r) => r.linkedListings, alerts: (r) => r.openAlerts,
  });
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cur = Math.min(page, pages - 1);
  const shown = rows.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };

  const simulation = all.length > 0 && all.every((p) => p.syncMode === "dry_run");

  return (
    <div>
      {simulation && (
        <div role="status" className="mb-3 rounded-lg border border-line bg-warnbg px-3 py-2 text-[13px] text-warn">
          Modo simulación: no se envía stock a Mercado Libre.
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <input
          type="search" aria-label="Buscar" placeholder="Buscar por EAN, SKU o nombre" value={text}
          onChange={(e) => reset(setText)(e.target.value)}
          className="h-8 min-w-0 flex-1 basis-56 rounded-lg border border-line bg-card px-3 text-[13px] text-ink"
        />
        <label className="grid gap-0.5 text-xs text-mut">Estado
          <select className={selectCls} value={state} onChange={(e) => reset(setState)(e.target.value as StockState | "all")}>
            <option value="all">Todos</option>
            {(Object.keys(STATE_LABEL) as StockState[]).map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="grid gap-0.5 text-xs text-mut">Categoría
          <select className={selectCls} value={category} onChange={(e) => reset(setCategory)(e.target.value)}>
            <option value="">Todas</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="grid gap-0.5 text-xs text-mut">Sincronización
          <select className={selectCls} value={mode} onChange={(e) => reset(setMode)(e.target.value as SyncMode | "all")}>
            <option value="all">Todas</option>
            <option value="dry_run">Simulación</option>
            <option value="live">En vivo</option>
          </select>
        </label>
        <button type="button" onClick={() => setCreating(true)} className="h-8 rounded-lg bg-navy px-3 text-[13px] font-semibold text-white">
          Nuevo producto
        </button>
        <button type="button" onClick={() => setMigrating(true)} className="h-8 rounded-lg border border-line bg-card px-3 text-[13px]">
          Migración inicial
        </button>
      </div>

      {list.isLoading ? (
        <div data-testid="skeleton" className="grid gap-2" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => <div key={i} className="h-9 animate-pulse rounded-lg bg-line/60" />)}
        </div>
      ) : list.error ? (
        <div className="rounded-xl border border-line bg-card p-6 text-center text-[13px]">
          <p className="m-0 mb-3 text-neg">
            {list.error.message === "ML_NOT_CONNECTED" ? "Conectá tu cuenta de Mercado Libre para ver el stock." : "No se pudieron cargar los productos."}
          </p>
          <button type="button" onClick={() => void list.refetch()} className="rounded-lg border border-line px-3 py-1.5">Reintentar</button>
        </div>
      ) : all.length === 0 && !query ? (
        <div className="rounded-xl border border-line bg-card p-6 text-center text-[13px]">
          <p className="m-0 mb-2 font-semibold">Todavía no hay productos: corré la migración inicial.</p>
          <p className="m-0 mb-3 text-mut">
            Importa los productos del último Excel de P&amp;L (subilo desde <a className="text-blue underline" href="/stock/sync">Sincronización</a>), o creá un producto a mano.
          </p>
          <button type="button" onClick={() => setMigrating(true)} className="rounded-lg bg-navy px-3 py-1.5 text-[13px] font-semibold text-white">
            Iniciar migración
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-card">
          <table className="tbl">
            <thead>
              <tr>
                <SortTh col="name" sort={sort} onSort={toggle}>Producto</SortTh>
                <SortTh col="ean" sort={sort} onSort={toggle}>EAN</SortTh>
                <SortTh col="sku" sort={sort} onSort={toggle}>SKU</SortTh>
                <SortTh col="category" sort={sort} onSort={toggle}>Categoría</SortTh>
                <SortTh col="onHand" sort={sort} onSort={toggle} className="ctr">En stock</SortTh>
                <SortTh col="inRepair" sort={sort} onSort={toggle} className="ctr">En reparación</SortTh>
                <SortTh col="unitCost" sort={sort} onSort={toggle} className="ctr">Costo unit.</SortTh>
                <SortTh col="coverage" sort={sort} onSort={toggle} className="ctr">Cobertura</SortTh>
                <th>Estado</th>
                <th>Sync</th>
                <SortTh col="linked" sort={sort} onSort={toggle} className="ctr">Pub.</SortTh>
                <SortTh col="alerts" sort={sort} onSort={toggle} className="ctr">Alertas</SortTh>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={12} className="text-center text-mut">Ningún producto coincide con los filtros.</td></tr>
              )}
              {shown.map((p) => {
                const st = stockState(p);
                const brk = breakDate(p.coverageDays);
                return (
                  <tr
                    key={p.id} data-testid="product-row" tabIndex={0} className="cursor-pointer hover:bg-bg"
                    onClick={() => setOpenId(p.id)}
                    onKeyDown={(e) => { if (e.key === "Enter") setOpenId(p.id); }}
                  >
                    <td data-testid="name" className="font-medium">{p.name}</td>
                    <td>{p.ean ?? "–"}</td>
                    <td>{p.sku ?? "–"}</td>
                    <td>{p.category || "–"}</td>
                    <td className="ctr">{fmtNum(p.onHand, 2)}</td>
                    <td className="ctr">{fmtNum(p.inRepair, 2)}</td>
                    <td className="ctr">{fmtArs(p.unitCost)}</td>
                    <td className="ctr" title={FORECAST_TIP}>
                      {p.coverageDays === null ? "–" : `${fmtNum(p.coverageDays, 0)} d${brk ? ` · ${brk}` : ""}`}
                    </td>
                    <td><Chip tone={STATE_TONE[st]}>{STATE_LABEL[st]}</Chip></td>
                    <td>{p.syncMode === "live" ? <Chip tone="bg-posbg text-pos">En vivo</Chip> : <Chip tone="bg-bg text-mut">Simulación</Chip>}</td>
                    <td className="ctr">{p.linkedListings}</td>
                    <td className="ctr">{p.openAlerts > 0 ? <Chip tone="bg-negbg text-neg">{String(p.openAlerts)}</Chip> : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {pages > 1 && (
            <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[13px] text-mut">
              <span>{fmtNum(rows.length)} productos · página {cur + 1} de {pages}</span>
              <span className="flex gap-2">
                <button type="button" disabled={cur === 0} onClick={() => setPage(cur - 1)} className="rounded border border-line px-2 py-0.5 disabled:opacity-40">Anterior</button>
                <button type="button" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} className="rounded border border-line px-2 py-0.5 disabled:opacity-40">Siguiente</button>
              </span>
            </div>
          )}
        </div>
      )}

      {openId !== null && <ProductDrawer productId={openId} onClose={() => setOpenId(null)} />}
      {creating && <CreateProductModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); }} />}
      {migrating && <CutoverDialog onClose={() => setMigrating(false)} />}
    </div>
  );
}
