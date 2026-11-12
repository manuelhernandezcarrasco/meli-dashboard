"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import type { AlertRow, AlertStatus, AlertType } from "~/lib/stock-contracts";
import { api } from "~/trpc/react";
import {
  ageLabel, groupAlerts, listingUrl, productHref, SEVERITY_CLASS, STATUS_FILTERS, statusesOf, TYPE_LABEL, TYPE_SEVERITY,
  type StatusFilter,
} from "./logic";
import { ResolvePanel } from "./ResolvePanel";
import { Btn, inputCls } from "./ui";

type Override = { status: AlertStatus; resolution?: string };

export function AlertsTab() {
  const [filter, setFilter] = useState<StatusFilter>("active");
  const [type, setType] = useState<AlertType | "">("");
  const [productId, setProductId] = useState<number | "">("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [overrides, setOverrides] = useState<Record<number, Override>>({});
  const [banner, setBanner] = useState("");
  const [now] = useState(() => Date.now());

  const utils = api.useUtils();
  const input = { status: statusesOf(filter), ...(type ? { type: [type] } : {}) };
  const list = api.stockAlerts.list.useQuery(input);
  const counts = api.stockAlerts.counts.useQuery();
  const ackM = api.stockAlerts.acknowledge.useMutation();
  const resolveM = api.stockAlerts.resolve.useMutation();

  const refresh = async () => {
    await Promise.all([
      utils.stockAlerts.list.invalidate(), utils.stockAlerts.counts.invalidate(),
      utils.stockProducts.invalidate(), utils.stockSync.invalidate(),
    ]);
  };

  /** Optimistic: show the new state at once; roll back and tell the user when the server refuses. */
  const optimistic = async (id: number, next: Override, call: () => Promise<unknown>) => {
    setOverrides((o) => ({ ...o, [id]: next }));
    try {
      await call();
      await refresh();
    } catch (e) {
      setBanner(e instanceof Error ? e.message : "No se pudo actualizar la alerta");
      throw e;
    } finally {
      setOverrides((o) => Object.fromEntries(Object.entries(o).filter(([k]) => Number(k) !== id)));
    }
  };
  const acknowledge = (id: number) =>
    optimistic(id, { status: "acknowledged" }, () => ackM.mutateAsync({ id }));
  const resolve = (id: number, resolution: string) =>
    optimistic(id, { status: "resolved", resolution }, () => resolveM.mutateAsync({ id, resolution }));

  const allowed = new Set<AlertStatus>(statusesOf(filter));
  const rows: AlertRow[] = useMemo(
    () => (list.data ?? []).map((r) => (overrides[r.id] ? { ...r, ...overrides[r.id] } : r)),
    [list.data, overrides],
  );
  const products = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of rows) if (r.productId != null) m.set(r.productId, r.productName ?? `Producto ${r.productId}`);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);
  const visible = rows.filter((r) => allowed.has(r.status) && (productId === "" || r.productId === productId));
  const groups = groupAlerts(visible);
  const open = counts.data?.open ?? 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-base font-semibold">Alertas</h2>
        {open > 0 && (
          <span aria-label={`${open} alertas abiertas`} className="rounded-full bg-warnbg px-2 py-[2px] text-xs font-semibold text-warn">
            {open} {open === 1 ? "abierta" : "abiertas"}
          </span>
        )}
      </div>

      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <select aria-label="Estado" className={inputCls} value={filter} onChange={(e) => setFilter(e.target.value as StatusFilter)}>
          {STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <select aria-label="Tipo" className={inputCls} value={type} onChange={(e) => setType(e.target.value as AlertType | "")}>
          <option value="">Todos los tipos</option>
          {(Object.keys(TYPE_LABEL) as AlertType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <select
          aria-label="Producto" className={inputCls} value={productId}
          onChange={(e) => setProductId(e.target.value === "" ? "" : Number(e.target.value))}
        >
          <option value="">Todos los productos</option>
          {products.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>

      {banner && (
        <div role="alert" className="mb-3 flex items-center justify-between gap-2 rounded-md bg-negbg px-3 py-2 text-[13px] text-neg">
          <span>{banner}</span>
          <button type="button" aria-label="Cerrar aviso" className="cursor-pointer border-0 bg-transparent text-neg" onClick={() => setBanner("")}>✕</button>
        </div>
      )}

      {list.isLoading ? (
        <p className="text-sm text-mut">Cargando alertas…</p>
      ) : list.isError ? (
        <div role="alert" className="rounded-md bg-negbg px-3 py-2.5 text-[13px] text-neg">
          No se pudieron cargar las alertas{list.error?.message ? `: ${list.error.message}` : ""}.{" "}
          <Btn onClick={() => void list.refetch()}>Reintentar</Btn>
        </div>
      ) : groups.length === 0 ? (
        <p className="rounded-xl border border-line bg-card px-4 py-8 text-center text-sm text-mut">Sin alertas</p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <section key={g.type} aria-label={g.label}>
              <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold tracking-[0.06em] text-mut uppercase">
                <span className={`inline-block h-2 w-2 rounded-full ${SEVERITY_CLASS[g.severity].dot}`} />
                {g.label}
                <span className={`rounded-full px-1.5 text-xs normal-case ${SEVERITY_CLASS[g.severity].chip}`}>{g.rows.length}</span>
              </h3>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {g.rows.map((r) => (
                  <AlertItem
                    key={r.id} row={r} now={now} expanded={openId === r.id}
                    onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                    acknowledge={() => acknowledge(r.id)}
                    resolve={(res) => resolve(r.id, res)}
                    refresh={refresh}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function AlertItem({ row, now, expanded, onToggle, acknowledge, resolve, refresh }: {
  row: AlertRow; now: number; expanded: boolean; onToggle: () => void;
  acknowledge: () => Promise<void>; resolve: (r: string) => Promise<void>; refresh: () => Promise<void>;
}) {
  const sev = SEVERITY_CLASS[TYPE_SEVERITY[row.type]];
  const done = row.status === "resolved";
  return (
    <li className="rounded-xl border border-line bg-card px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${sev.dot}`} />
        <div className="min-w-0 flex-1 basis-60">
          <div className="text-sm font-semibold">{row.title}</div>
          <div className="text-[13px] text-mut">{row.detail}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-mut">
            {row.productId != null && (
              <Link href={productHref(row.productId)} className="text-blue">{row.productName ?? `Producto ${row.productId}`}</Link>
            )}
            {row.itemId && (
              <a href={listingUrl(row.itemId)} target="_blank" rel="noreferrer" className="text-blue">{row.itemId}</a>
            )}
            <span>{ageLabel(row.createdAt, now)}</span>
            {row.status === "acknowledged" && <span>Reconocida</span>}
            {done && <span>Resuelta{row.resolution ? `: ${row.resolution}` : ""}</span>}
          </div>
        </div>
        {!done && (
          <div className="flex gap-2">
            {row.status === "open" && <Btn onClick={() => void acknowledge().catch(() => undefined)}>Reconocer</Btn>}
            <Btn kind="primary" aria-expanded={expanded} onClick={onToggle}>Resolver</Btn>
          </div>
        )}
      </div>
      {expanded && !done && (
        <div className="mt-3 border-t border-line pt-3">
          <ResolvePanel
            alert={row} refresh={refresh}
            acknowledge={acknowledge}
            resolve={async (res) => { await resolve(res); }}
          />
        </div>
      )}
    </li>
  );
}
