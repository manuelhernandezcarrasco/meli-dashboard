"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ars } from "~/lib/dashboard-math";
import { fmtDate } from "./format";
import { uploadInvoice } from "./upload";
import { useInvoicesApi } from "./useInvoicesApi";

type UploadError = { message: string; existingInvoiceId?: number };

export function InvoicesList() {
  const router = useRouter();
  const list = useInvoicesApi().list.useQuery();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState<UploadError | null>(null);

  async function send(file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    setErr(null);
    const r = await uploadInvoice(file);
    setBusy(false);
    if (r.ok) router.push(`/stock/invoices/${r.invoiceId}`);
    else setErr({ message: r.message, existingInvoiceId: r.existingInvoiceId });
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void send(e.dataTransfer.files[0]);
        }}
        data-testid="dropzone"
        className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-4 ${
          drag ? "border-navy bg-posbg" : "border-line bg-card"
        }`}
      >
        <div className="min-w-0 text-[13px]">
          <div className="font-semibold">Facturas de compra</div>
          <div className="text-xs text-mut">Arrastrá el PDF del proveedor acá o elegilo (máx. 10 MB).</div>
        </div>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          data-testid="invoice-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            void send(f);
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="cursor-pointer rounded-lg border-0 bg-navy px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Leyendo factura…" : "Subir factura"}
        </button>
      </div>

      {busy ? (
        <p role="status" className="mb-3 text-xs text-mut">
          <span className="mr-1.5 inline-block h-3 w-3 animate-spin rounded-full border-2 border-line border-t-navy align-[-2px]" />
          Analizando el PDF…
        </p>
      ) : null}
      {err ? (
        <p role="alert" className="mb-3 rounded-lg bg-negbg px-3 py-2 text-[13px] text-neg">
          {err.message}{" "}
          {err.existingInvoiceId ? (
            <Link href={`/stock/invoices/${err.existingInvoiceId}`} className="font-semibold underline">
              Ver la factura existente
            </Link>
          ) : null}
        </p>
      ) : null}

      {list.isLoading ? <p className="text-[13px] text-mut">Cargando facturas…</p> : null}
      {list.error ? (
        <p role="alert" className="text-[13px] text-neg">
          No se pudieron cargar las facturas.{" "}
          <button type="button" onClick={() => void list.refetch()} className="cursor-pointer border-0 bg-transparent text-neg underline">
            Reintentar
          </button>
        </p>
      ) : null}
      {list.data && list.data.length === 0 ? (
        <p className="rounded-xl border border-line bg-card px-4 py-6 text-center text-[13px] text-mut">
          Todavía no cargaste facturas.
        </p>
      ) : null}
      {list.data && list.data.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-line bg-card">
          <table className="w-full min-w-[720px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-xs text-mut">
                <th className="px-3 py-2 font-medium">Proveedor</th>
                <th className="px-3 py-2 font-medium">Número</th>
                <th className="px-3 py-2 font-medium">Fecha</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 text-right font-medium">Líneas</th>
                <th className="px-3 py-2 font-medium">Estado</th>
                <th className="px-3 py-2 font-medium">Aplicada</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.invoiceId} className="border-t border-line">
                  <td className="px-3 py-2">{r.supplierName}</td>
                  <td className="px-3 py-2">
                    <Link href={`/stock/invoices/${r.invoiceId}`} className="font-semibold text-navy underline">
                      {r.number}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{fmtDate(r.issueDate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{ars(r.total)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.lineCount}</td>
                  <td className="px-3 py-2">
                    {r.status === "applied" ? (
                      <span className="rounded-full bg-posbg px-2 text-xs font-semibold text-pos">Aplicada</span>
                    ) : (
                      <span className="rounded-full bg-warnbg px-2 text-xs font-semibold text-warn">
                        Borrador{r.unresolvedLines > 0 ? ` · ${r.unresolvedLines} sin resolver` : ""}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-mut">{r.appliedAt ? fmtDate(r.appliedAt) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
