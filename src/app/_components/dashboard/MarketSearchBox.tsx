"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export const SEARCH_DEBOUNCE_MS = 250;

export type MarketSearchHit = { itemId: string; title: string; catalogProductId: string | null };

export const marketUrl = (catalogProductId: string) =>
  `/market-research/${encodeURIComponent(catalogProductId)}`;

export type MarketSearch = (query: string) => Promise<MarketSearchHit[]>;

export function MarketSearchBox({ search }: { search: MarketSearch }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [hits, setHits] = useState<MarketSearchHit[] | null>(null);

  useEffect(() => {
    const q = text.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      search(q).then(
        (r) => { if (!stale) setHits(r); },
        () => { if (!stale) setHits([]); },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { stale = true; clearTimeout(t); };
  }, [text, search]);

  return (
    <div className="relative w-full max-w-xs">
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Investigar mercado: buscar mis productos…"
        aria-label="Buscar producto propio para investigar mercado"
        className="w-full rounded-md border border-line bg-card px-2.5 py-1 text-xs font-normal text-ink"
      />
      {hits ? (
        <ul role="listbox" className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border border-line bg-card text-xs font-normal shadow-lg">
          {hits.length === 0 ? <li className="px-2.5 py-1.5 text-mut">Sin resultados</li> : null}
          {hits.map((h) =>
            h.catalogProductId ? (
              <li key={h.itemId} role="option" aria-selected={false}>
                <button
                  type="button"
                  className="block w-full cursor-pointer px-2.5 py-1.5 text-left hover:bg-bg"
                  onClick={() => router.push(marketUrl(h.catalogProductId!))}
                >
                  {h.title}
                </button>
              </li>
            ) : (
              <li key={h.itemId} role="option" aria-selected={false} aria-disabled="true" className="px-2.5 py-1.5 text-mut">
                {h.title}
                <br />
                <span className="text-[11px]">Sin catálogo — no soportado todavía</span>
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Stock rows carry an EAN, not an item id, so the catalog id is resolved by searching our own
 * products by the row's description and taking the first hit that has one.
 */
export function InvestigateButton({ search, desc }: { search: MarketSearch; desc: string }) {
  const router = useRouter();
  const [none, setNone] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setNone(false);
    setBusy(true);
    try {
      const hit = (await search(desc)).find((h) => h.catalogProductId);
      if (hit?.catalogProductId) router.push(marketUrl(hit.catalogProductId));
      else setNone(true);
    } catch {
      setNone(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" disabled={busy} className="cursor-pointer text-blue underline" onClick={() => void go()}>
        Investigar mercado
      </button>
      {none ? <div role="status" className="text-mut">Sin catálogo</div> : null}
    </>
  );
}
