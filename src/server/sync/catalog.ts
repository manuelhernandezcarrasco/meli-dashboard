import type { Line } from "~/lib/contracts";
import { saveListingMatches, type ListingMatch } from "~/server/store/listings";
import type { Marketplace } from "~/server/store/marketplace";

/**
 * Links every sold listing with its title and Excel product, so the market research can find the
 * products the P&L knows by their Excel name (the catalog id itself is stored by `enrich`).
 * Returns how many listings were recorded.
 */
export async function saveCatalogProducts(ownerId: string, mp: Marketplace, lines: Line[]): Promise<number> {
  const byItem = new Map<string, ListingMatch>();
  for (const l of lines) {
    if (l.channel !== "ML" || !l.itemId) continue;
    const matched = l.cat !== "SIN MATCH" && !!l.ean;
    const cur = byItem.get(l.itemId);
    if (cur?.ean && !matched) continue; // keep the matched version of the same listing
    byItem.set(l.itemId, {
      itemId: l.itemId,
      title: l.titleMl,
      ean: matched ? l.ean : "",
      desc: matched ? l.desc : "",
    });
  }
  await saveListingMatches(ownerId, mp, [...byItem.values()]);
  return byItem.size;
}
