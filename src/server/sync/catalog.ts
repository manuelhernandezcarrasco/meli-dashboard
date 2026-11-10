import type { Line } from "~/lib/contracts";
import { writeCache } from "./enrich";

/** Stored value of `catalog:<itemId>` in `ApiCache` (shared with the market search). */
export interface CatalogEntry {
  catalogProductId: string | null;
  title?: string;
  /** EAN of the Excel product this listing is matched to ("" when unmatched). */
  ean?: string;
  /** Excel description of that product. */
  desc?: string;
}

/**
 * Links every sold listing with its Excel product and its Mercado Libre `catalog_product_id`, so
 * the market research can find the products the P&L knows by their Excel name and resolve the
 * catalog without another ML call.
 */
export async function saveCatalogProducts(
  ownerId: string,
  lines: Line[],
  catalogIds: Record<string, string | null>,
): Promise<number> {
  const byItem = new Map<string, CatalogEntry>();
  for (const l of lines) {
    if (l.channel !== "ML" || !l.itemId) continue;
    const matched = l.cat !== "SIN MATCH" && !!l.ean;
    const cur = byItem.get(l.itemId);
    if (cur?.ean && !matched) continue; // keep the matched version of the same listing
    byItem.set(l.itemId, {
      catalogProductId: catalogIds[l.itemId] ?? null,
      title: l.titleMl,
      ean: matched ? l.ean : "",
      desc: matched ? l.desc : "",
    });
  }
  await writeCache(ownerId, [...byItem].map(([id, e]) => [`catalog:${id}`, e]));
  return byItem.size;
}
