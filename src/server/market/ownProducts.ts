import type { DashboardData } from "~/lib/contracts";
import { normalizeText } from "~/lib/normalize";

export const MAX_SEARCH_RESULTS = 10;

export type OwnProduct = { itemId: string; title: string; /** Excel description of the matched product */ desc?: string };
export type OwnProductHit = OwnProduct & { catalogProductId: string | null };

/** Resolves an item's `catalog_product_id` (implemented by T9's `getCatalogProductId`). */
export interface CatalogIdLookup {
  (ownerId: string, itemId: string): Promise<string | null>;
}

/** Where an item's catalog id is remembered (production: `Listing.catalogProductId`). */
export interface CatalogStore {
  /** undefined = never asked; null = asked and the item has no catalog product. */
  get(ownerId: string, itemId: string): Promise<string | null | undefined>;
  set(ownerId: string, itemId: string, catalogProductId: string | null): Promise<void>;
}

export { normalizeText };

/**
 * Our distinct products (itemId, title) as the snapshot knows them. The snapshot payload only
 * carries item ids for the listings in `autoMatches`, `suggestions` and `unmatched`.
 */
export function collectOwnProducts(
  data: Pick<DashboardData, "unmatched" | "suggestions" | "autoMatches">,
): OwnProduct[] {
  const seen = new Map<string, OwnProduct>();
  for (const p of [...data.autoMatches, ...data.suggestions, ...data.unmatched]) {
    if (p.itemId && !seen.has(p.itemId)) seen.set(p.itemId, { itemId: p.itemId, title: p.title });
  }
  return [...seen.values()];
}

/** Catalog id for one item, remembered (including "no catalog") so Mercado Libre is asked once. */
export async function cachedCatalogId(
  deps: { ownerId: string; lookup: CatalogIdLookup; cache: CatalogStore },
  itemId: string,
): Promise<string | null> {
  const hit = await deps.cache.get(deps.ownerId, itemId);
  if (hit !== undefined) return hit;
  const id = await deps.lookup(deps.ownerId, itemId);
  await deps.cache.set(deps.ownerId, itemId, id);
  return id;
}

export async function searchOwnProducts(
  deps: { ownerId: string; lookup: CatalogIdLookup; cache: CatalogStore; products: OwnProduct[] },
  query: string,
): Promise<OwnProductHit[]> {
  const q = normalizeText(query);
  if (!q) return [];
  const matches = deps.products
    .filter((p) => normalizeText(p.title).includes(q) || (p.desc ? normalizeText(p.desc).includes(q) : false))
    .slice(0, MAX_SEARCH_RESULTS);
  return Promise.all(
    matches.map(async (p) => ({ ...p, catalogProductId: await cachedCatalogId(deps, p.itemId) })),
  );
}
