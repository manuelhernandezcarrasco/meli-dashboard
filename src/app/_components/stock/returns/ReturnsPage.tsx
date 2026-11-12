"use client";

import { useState } from "react";

import type { ReturnOutcome, ReturnRow } from "~/lib/stock-contracts";
import { api } from "~/trpc/react";
import { ACTION_LABEL, allowedActions, DEFAULT_FILTER, OUTCOME_LABEL, OUTCOME_ORDER, type ReturnAction } from "./actions";
import { ConfirmDialog } from "./ConfirmDialog";
import { RegisterReturnDialog } from "./RegisterReturnDialog";

const CHIP: Record<ReturnOutcome, string> = {
  pending: "bg-warnbg text-warn",
  in_repair: "bg-warnbg text-warn",
  lost: "bg-negbg text-neg",
  restocked: "bg-posbg text-pos",
};

const fmtDate = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");
const num = (n: number) => new Intl.NumberFormat("es-AR").format(n);

export function ReturnsPage() {
  const list = api.stockReturns.list.useQuery({});
  const [filter, setFilter] = useState<ReturnOutcome[]>(DEFAULT_FILTER);
  const [pendingAction, setPendingAction] = useState<{ row: ReturnRow; action: ReturnAction } | null>(null);
  const [registering, setRegistering] = useState(false);

  const all = list.data ?? [];
  const rows = all.filter((r) => filter.includes(r.outcome));
  const sum = (o: ReturnOutcome) => all.filter((r) => r.outcome === o).reduce((s, r) => s + r.quantity, 0);
  const toggle = (o: ReturnOutcome) => setFilter((f) => (f.includes(o) ? f.filter((x) => x !== o) : [...f, o]));

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="rounded-xl border border-line bg-card px-4 py-2.5">
          <div className="text-xs text-mut">Pendientes</div>
          <div className="text-lg font-semibold" data-testid="pending-count">{num(sum("pending"))} u.</div>
        </div>
        <div className="rounded-xl border border-line bg-card px-4 py-2.5">
          <div className="text-xs text-mut">En reparación</div>
          <div className="text-lg font-semibold" data-testid="repair-count">{num(sum("in_repair"))} u.</div>
        </div>
        <button
          type="button"
          onClick={() => setRegistering(true)}
          className="ml-auto cursor-pointer rounded-lg border border-navy bg-navy px-3 py-2 text-[13px] font-semibold text-white"
        >
          Registrar devolución
        </button>
      </div>

      <div role="group" aria-label="Filtrar por estado" className="mb-3 flex flex-wrap gap-1.5">
        {OUTCOME_ORDER.map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={filter.includes(o)}
            onClick={() => toggle(o)}
            className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${
              filter.includes(o) ? "border-navy bg-navy text-white" : "border-line bg-card text-mut"
            }`}
          >
            {OUTCOME_LABEL[o]}
          </button>
        ))}
      </div>

      {list.error ? (
        <p role="alert" className="text-sm text-neg">No se pudieron cargar las devoluciones: {list.error.message}</p>
      ) : list.isLoading ? (
        <p className="text-sm text-mut">Cargando…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-line bg-card px-4 py-6 text-center text-sm text-mut">
          No hay devoluciones con este filtro.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-card">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-mut">
                <th className="px-3 py-2 font-semibold">Producto</th>
                <th className="px-3 py-2 font-semibold">Orden</th>
                <th className="px-3 py-2 text-right font-semibold">Cant.</th>
                <th className="px-3 py-2 font-semibold">Motivo</th>
                <th className="px-3 py-2 font-semibold">Abierta</th>
                <th className="px-3 py-2 font-semibold">Estado</th>
                <th className="px-3 py-2 font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2">
                    {r.productName}
                    {r.note ? <div className="text-xs text-mut">Nota: {r.note}</div> : null}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.orderId}</td>
                  <td className="px-3 py-2 text-right">{num(r.quantity)}</td>
                  <td className="px-3 py-2">{r.reason ?? "–"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(r.openedAt)}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded-full px-2 text-xs leading-[19px] font-semibold ${CHIP[r.outcome]}`}>
                      {OUTCOME_LABEL[r.outcome]}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      {allowedActions(r.outcome).map((a) => (
                        <button
                          key={a}
                          type="button"
                          onClick={() => setPendingAction({ row: r, action: a })}
                          className="cursor-pointer rounded-md border border-line bg-card px-2 py-1 text-xs hover:border-navy"
                        >
                          {ACTION_LABEL[a]}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingAction ? (
        <ConfirmDialog
          row={pendingAction.row}
          action={pendingAction.action}
          onClose={() => setPendingAction(null)}
          onDone={() => { setPendingAction(null); void list.refetch(); }}
        />
      ) : null}
      {registering ? (
        <RegisterReturnDialog onClose={() => setRegistering(false)} onDone={() => { setRegistering(false); void list.refetch(); }} />
      ) : null}
    </section>
  );
}
