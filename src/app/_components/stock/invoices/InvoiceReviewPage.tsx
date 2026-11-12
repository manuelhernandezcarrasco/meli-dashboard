"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ars } from "~/lib/dashboard-math";
import { fmtDate, fmtFactor, fmtPctFactor, fmtQty, isUnresolved, project, summarize, summaryText } from "./format";
import { LineResolver } from "./LineResolver";
import { useInvoicesApi } from "./useInvoicesApi";

const parseFactor = (s: string): number | null => {
  const n = Number(s.trim().replace(",", "."));
  return s.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

function Field({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-mut">{label}</div>
      <div className={`truncate text-[13px] tabular-nums ${strong ? "font-semibold" : ""}`}>{value}</div>
    </div>
  );
}

export function InvoiceReviewPage({ invoiceId }: { invoiceId: number }) {
  const router = useRouter();
  const inv = useInvoicesApi();
  const q = inv.getDraft.useQuery({ invoiceId });
  const refresh = () => void q.refetch();
  const setFactor = inv.setFeeFactor.useMutation({ onSuccess: refresh });
  const match = inv.matchLine.useMutation({ onSuccess: refresh });
  const create = inv.createProductFromLine.useMutation({ onSuccess: refresh });
  const skip = inv.skipLine.useMutation({ onSuccess: refresh });
  const confirm = inv.confirm.useMutation({ onSuccess: refresh });
  const discard = inv.discard.useMutation({ onSuccess: () => router.push("/stock/invoices") });

  const [factorText, setFactorText] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);
  const inFlight = useRef(false);

  const r = q.data;
  if (q.isLoading) return <p className="text-[13px] text-mut">Cargando factura…</p>;
  if (q.error || !r) {
    return (
      <p role="alert" className="text-[13px] text-neg">
        No se pudo cargar la factura{q.error ? `: ${q.error.message}` : ""}.{" "}
        <button type="button" onClick={refresh} className="cursor-pointer border-0 bg-transparent text-neg underline">
          Reintentar
        </button>
      </p>
    );
  }

  const isDraft = r.status === "draft";
  const typed = factorText == null ? null : parseFactor(factorText);
  const factor = isDraft && typed != null ? typed : r.feeFactor;
  const factorDirty = isDraft && typed != null && Math.abs(typed - r.feeFactor) > 1e-9;
  const factorInvalid = factorText != null && factorText.trim() !== "" && typed == null;
  const s = summarize({ ...r, feeFactor: factor });
  const blocked = !isDraft || s.unresolved > 0 || s.products === 0;
  const busy = match.isPending || create.isPending || skip.isPending || setFactor.isPending;
  const mutationError = match.error ?? create.error ?? skip.error ?? setFactor.error ?? confirm.error ?? discard.error;

  function doConfirm() {
    if (inFlight.current) return; // double-click protection
    inFlight.current = true;
    confirm.mutate(
      { invoiceId },
      {
        onSuccess: () => {
          setConfirmed(true);
          setDialog(false);
        },
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  }

  const th = "px-2 py-2 font-medium";
  return (
    <div className={isDraft ? "pb-24" : ""}>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
        <Link href="/stock/invoices" className="text-navy underline">
          ← Facturas
        </Link>
        <span className={`rounded-full px-2 text-xs font-semibold ${isDraft ? "bg-warnbg text-warn" : "bg-posbg text-pos"}`}>
          {isDraft ? "Borrador" : "Aplicada"}
        </span>
        {isDraft ? (
          <button type="button" onClick={() => setAskDiscard(true)} className="ml-auto cursor-pointer border-0 bg-transparent text-xs text-neg underline">
            Descartar borrador
          </button>
        ) : r.appliedAt ? (
          <span className="ml-auto text-xs text-mut">Aplicada el {fmtDate(r.appliedAt)}</span>
        ) : null}
      </div>

      {confirmed ? (
        <div role="status" className="mb-3 rounded-lg bg-posbg px-3 py-2 text-[13px] text-pos">
          Factura aplicada: stock y costos actualizados.{" "}
          <Link href="/stock/products" className="font-semibold underline">
            Ver productos
          </Link>
        </div>
      ) : null}
      {mutationError ? (
        <p role="alert" className="mb-3 rounded-lg bg-negbg px-3 py-2 text-[13px] text-neg">
          {mutationError.message || "No se pudo completar la acción."} Podés reintentar.
        </p>
      ) : null}
      {r.warnings.length > 0 ? (
        <div role="note" className="mb-3 rounded-lg border border-warn bg-warnbg px-3 py-2 text-[13px] text-warn">
          <div className="font-semibold">Avisos al leer el PDF</div>
          <ul className="m-0 mt-1 list-disc pl-5">
            {r.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-line bg-card px-4 py-3.5 sm:grid-cols-4 lg:grid-cols-7">
        <Field label="Proveedor" value={r.supplierName} strong />
        <Field label="Número" value={r.number} />
        <Field label="Fecha" value={fmtDate(r.issueDate)} />
        <Field label="Subtotal" value={ars(r.subtotal)} />
        <Field label="IVA" value={ars(r.ivaAmount)} />
        <Field label="Percepciones" value={ars(r.perceptionsAmount + r.otherTaxesAmount)} />
        <Field label="Total" value={ars(r.total)} strong />
      </div>

      <section aria-label="Factor de costo" className="mb-3 rounded-xl border border-line bg-card px-4 py-3.5">
        <h3 className="mb-1 text-sm font-semibold">
          Factor de costo{" "}
          {r.feeFactorOverridden ? <span className="ml-1 rounded-full bg-warnbg px-2 text-xs font-semibold text-warn">editado</span> : null}
        </h3>
        <p className="m-0 text-[13px]" data-testid="factor-sentence">
          Total ÷ subtotal = <b>{fmtFactor(r.total / r.subtotal)}</b> ({fmtPctFactor(r.total / r.subtotal)}): incluye IVA, percepciones e
          impuestos; el costo es bruto, no se descuenta nada.
        </p>
        {isDraft ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            <label htmlFor="fee-factor" className="text-mut">
              Factor aplicado
            </label>
            <input
              id="fee-factor"
              inputMode="decimal"
              value={factorText ?? String(r.feeFactor.toFixed(5)).replace(".", ",")}
              onChange={(e) => setFactorText(e.target.value)}
              aria-invalid={factorInvalid}
              className="w-28 rounded-lg border border-line bg-bg px-2 py-1 text-right tabular-nums"
            />
            <button
              type="button"
              disabled={!factorDirty || setFactor.isPending}
              onClick={() => typed != null && setFactor.mutate({ invoiceId, feeFactor: typed }, { onSuccess: () => setFactorText(null) })}
              className="cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs disabled:opacity-60"
            >
              Guardar factor
            </button>
            {r.feeFactorOverridden || factorText != null ? (
              <button
                type="button"
                disabled={setFactor.isPending}
                onClick={() => setFactor.mutate({ invoiceId, feeFactor: null }, { onSuccess: () => setFactorText(null) })}
                className="cursor-pointer border-0 bg-transparent text-xs text-navy underline"
              >
                Volver a total ÷ subtotal
              </button>
            ) : null}
            {factorInvalid ? <span className="text-xs text-neg">Ingresá un número mayor a 0.</span> : null}
            {factorDirty ? <span className="text-xs text-mut">Vista previa: falta guardar para aplicarlo.</span> : null}
          </div>
        ) : (
          <p className="m-0 mt-1 text-xs text-mut">Factor aplicado: {fmtFactor(r.feeFactor)}</p>
        )}
      </section>

      <div className="overflow-x-auto rounded-xl border border-line bg-card">
        <table className="w-full min-w-[1080px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-xs text-mut">
              <th className={`${th} text-right`}>Cant.</th>
              <th className={th}>Código</th>
              <th className={th}>EAN</th>
              <th className={th}>Descripción</th>
              <th className={`${th} text-right`}>Precio unit.</th>
              <th className={`${th} text-right`}>Costo unit. con impuestos</th>
              <th className={th}>Producto</th>
              <th className={`${th} text-right`}>Stock ahora → después</th>
              <th className={`${th} text-right`}>Costo ahora → después</th>
            </tr>
          </thead>
          <tbody>
            {r.lines.map((l) => {
              const p = project(l, factor);
              const unresolved = isUnresolved(l);
              const costChanged = p.costNow != null && p.costAfter != null && Math.abs(p.costNow - p.costAfter) > 0.005;
              return (
                <tr key={l.lineNo} data-testid={`line-${l.lineNo}`} className={`border-t border-line align-top ${l.skipped ? "opacity-50" : ""}`}>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtQty(l.quantity)}</td>
                  <td className="px-2 py-2">{l.supplierCode}</td>
                  <td className="px-2 py-2 tabular-nums">{l.ean ?? "–"}</td>
                  <td className="max-w-[260px] px-2 py-2">{l.description}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{ars(l.unitPrice)}</td>
                  <td className="px-2 py-2 text-right font-semibold tabular-nums" data-testid={`landed-${l.lineNo}`}>
                    {ars(p.landedUnit)}
                  </td>
                  <td className="min-w-[240px] px-2 py-2">
                    {l.skipped ? (
                      <span className="text-mut">Línea omitida</span>
                    ) : unresolved ? (
                      isDraft ? (
                        <>
                          <div className="mb-1 font-semibold text-warn">Sin match</div>
                          <LineResolver
                            line={l}
                            disabled={busy}
                            onMatch={(productId) => match.mutate({ invoiceId, lineNo: l.lineNo, productId })}
                            onCreate={(product) => create.mutate({ invoiceId, lineNo: l.lineNo, product })}
                            onSkip={() => skip.mutate({ invoiceId, lineNo: l.lineNo })}
                          />
                        </>
                      ) : (
                        <span className="text-mut">Sin match</span>
                      )
                    ) : (
                      <>
                        <div>{l.productName}</div>
                        {Object.keys(l.willFill ?? {}).length > 0 && isDraft ? (
                          <div className="text-xs text-mut">
                            Se completará:{" "}
                            {Object.entries(l.willFill)
                              .filter(([, v]) => v)
                              .map(([k, v]) => `${k}: ${String(v)}`)
                              .join(" · ")}
                          </div>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {p.stockAfter != null ? (
                      <>
                        {fmtQty(p.stockNow ?? 0)} → <b className="text-pos">{fmtQty(p.stockAfter)}</b>
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums" data-testid={`cost-${l.lineNo}`}>
                    {p.costAfter != null ? (
                      <>
                        {ars(p.costNow ?? 0)} → <b className={costChanged ? "text-warn" : ""}>{ars(p.costAfter)}</b>
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!isDraft ? (
        <p className="mt-3 text-xs text-mut">
          Factura aplicada: es de solo lectura. Cada línea generó una entrada de stock «compra» al costo con impuestos; las correcciones se
          hacen con un ajuste manual desde el producto.
        </p>
      ) : null}

      {isDraft ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card px-4 py-3">
          <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 text-[13px]">
              {s.unresolved > 0 ? (
                <span className="font-semibold text-warn">
                  Faltan resolver {s.unresolved} {s.unresolved === 1 ? "línea" : "líneas"}.
                </span>
              ) : s.products === 0 ? (
                <span className="font-semibold text-warn">Omitiste todas las líneas: no hay nada para aplicar.</span>
              ) : (
                <span>{summaryText(s)}</span>
              )}
              {s.skipped > 0 ? <span className="text-mut"> · {s.skipped} omitida(s)</span> : null}
            </div>
            <button
              type="button"
              disabled={blocked || factorDirty || confirm.isPending}
              onClick={() => setDialog(true)}
              className="cursor-pointer rounded-lg border-0 bg-navy px-4 py-2 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Confirmar y aplicar
            </button>
          </div>
        </div>
      ) : null}

      {dialog ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
          <div role="dialog" aria-modal="true" aria-label="Confirmar factura" className="w-full max-w-[420px] rounded-xl border border-line bg-card p-4">
            <h3 className="m-0 mb-2 text-sm font-semibold">¿Aplicar la factura {r.number}?</h3>
            <p className="m-0 text-[13px]">{summaryText(s)}</p>
            <p className="m-0 mt-1 text-xs text-mut">
              Factor {fmtFactor(factor)}. Se suma el stock y se recalcula el costo promedio. Esta acción no se puede deshacer.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" disabled={confirm.isPending} onClick={() => setDialog(false)} className="cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-[13px] disabled:opacity-60">
                Cancelar
              </button>
              <button type="button" disabled={confirm.isPending} onClick={doConfirm} className="cursor-pointer rounded-lg border-0 bg-navy px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-60">
                {confirm.isPending ? "Aplicando…" : "Aplicar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {askDiscard ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
          <div role="dialog" aria-modal="true" aria-label="Descartar borrador" className="w-full max-w-[380px] rounded-xl border border-line bg-card p-4">
            <h3 className="m-0 mb-2 text-sm font-semibold">¿Descartar este borrador?</h3>
            <p className="m-0 text-[13px] text-mut">No se modifica el stock. Después podés volver a subir el PDF.</p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setAskDiscard(false)} className="cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-[13px]">
                Cancelar
              </button>
              <button type="button" disabled={discard.isPending} onClick={() => discard.mutate({ invoiceId })} className="cursor-pointer rounded-lg border-0 bg-neg px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-60">
                Descartar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
