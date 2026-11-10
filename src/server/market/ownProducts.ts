import type { DashboardData } from "~/lib/contracts";

export const MAX_SEARCH_RESULTS = 10;

export type OwnProduct = { itemId: string; title: string };
export type OwnProductHit = OwnProduct & { catalogProductId: string | null };

/** Resolves an item's `catalog_product_id` (implemented by T9's `getCatalogProductId`). */
export interface CatalogIdLookup {
  (ownerId: string, itemId: string): Promise<string | null>;
}

/** Minimal key/value store; production is backed by `ApiCache`. */
export interface CatalogCache {
  get(ownerId: string, key: string): Promise<unknown>;
  set(ownerId: string, key: string, value: unknown): Promise<void>;
}

export const catalogCacheKey = (itemId: string) => `catalog:${itemId}`;

/** Lowercase + strip accents, so "Cámara" matches "camara". */
export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().trim();
}

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

/** Catalog id for one item, cached (including "no catalog") as `catalog:<itemId>`. */
export async function cachedCatalogId(
  deps: { ownerId: string; lookup: CatalogIdLookup; cache: CatalogCache },
  itemId: string,
): Promise<string | null> {
  const key = catalogCacheKey(itemId);
  const hit = await deps.cache.get(deps.ownerId, key);
  if (hit && typeof hit === "object" && "catalogProductId" in hit) {
    const v = (hit as { catalogProductId: unknown }).catalogProductId;
    if (v === null || typeof v === "string") return v;
  }
  const id = await deps.lookup(deps.ownerId, itemId);
  await deps.cache.set(deps.ownerId, key, { catalogProductId: id });
  return id;
}

export async function searchOwnProducts(
  deps: { ownerId: string; lookup: CatalogIdLookup; cache: CatalogCache; products: OwnProduct[] },
  query: string,
): Promise<OwnProductHit[]> {
  const q = normalizeText(query);
  if (!q) return [];
  const matches = deps.products
    .filter((p) => normalizeText(p.title).includes(q))
    .slice(0, MAX_SEARCH_RESULTS);
  return Promise.all(
    matches.map(async (p) => ({ ...p, catalogProductId: await cachedCatalogId(deps, p.itemId) })),
  );
}
