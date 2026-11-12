"use client";

import Link from "next/link";

export type IndexRow = {
  key: string;
  title: string;
  ean: string | null;
  catalogProductId: string | null;
  lastScanAt: string | null;
};

export const marketHref = (catalogProductId: string) =>
  `/market-research/${encodeURIComponent(catalogProductId)}`;

const fmt = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Argentina/Buenos_Aires",
});

function Meta({ row }: { row: IndexRow }) {
  return (
    <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-mut">
      <span>EAN: {row.ean ?? "—"}</span>
      <span>Catálogo: {row.catalogProductId ?? "—"}</span>
      <span>Último escaneo: {row.lastScanAt ? fmt.format(new Date(row.lastScanAt)) : "—"}</span>
    </div>
  );
}

export function IndexResults({
  rows, loading, error, onRetry, searching,
}: {
  rows: IndexRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  searching: boolean;
}) {
  if (error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-neg bg-negbg px-4 py-2.5 text-[13px] text-neg">
        <span>No se pudo cargar: {error}.</span>
        <button type="button" onClick={onRetry} className="cursor-pointer rounded-lg border border-neg bg-card px-3 py-1 text-[13px] font-semibold text-neg">
          Reintentar
        </button>
      </div>
    );
  }
  if (loading) {
    return <div className="h-40 animate-pulse rounded-xl border border-line bg-card" role="status" aria-busy="true" aria-label="Cargando" />;
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-card p-8 text-center text-[13px] text-mut">
        {searching
          ? "No encontramos productos con ese nombre."
          : "Todavía no investigaste ningún producto. Buscá uno para empezar."}
      </div>
    );
  }
  return (
    <div>
      {!searching ? <h2 className="m-0 mb-2 text-[13px] font-semibold text-mut">Investigados recientemente</h2> : null}
      <ul className="m-0 list-none divide-y divide-line overflow-hidden rounded-xl border border-line bg-card p-0">
        {rows.map((r) =>
          r.catalogProductId ? (
            <li key={r.key}>
              <Link href={marketHref(r.catalogProductId)} className="block px-4 py-2.5 text-ink no-underline hover:bg-bg">
                <div className="text-[13px] font-semibold">{r.title}</div>
                <Meta row={r} />
              </Link>
            </li>
          ) : (
            <li key={r.key} className="px-4 py-2.5 text-mut">
              <div className="text-[13px] font-semibold">{r.title}</div>
              <Meta row={r} />
              <div className="mt-0.5 text-[12px]">Sin catálogo — no soportado todavía</div>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
