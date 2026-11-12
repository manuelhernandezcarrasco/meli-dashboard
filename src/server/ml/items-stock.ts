import { mlFetch, type MlFetchOpts, type TokenAuth } from "./http";
import { tokenAuthFor } from "./tokens";

const API = "https://api.mercadolibre.com";
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** `/items?ids=` accepts at most 20 ids. */
const MULTIGET = 20;

export interface ItemStock {
  itemId: string;
  available_quantity: number;
  status: string;
  listing_type_id: string;
  variations: { id: number; available_quantity: number }[];
  /** `shipping.logistic_type`: `fulfillment` = ML Full. Null when absent. */
  logistic_type: string | null;
}

export interface ItemStockOpts {
  auth?: TokenAuth;
  sleep?: MlFetchOpts["sleep"];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parse(body: any): ItemStock | null {
  if (!body || typeof body.id !== "string") return null;
  return {
    itemId: String(body.id).toUpperCase(),
    available_quantity: Number(body.available_quantity ?? 0),
    status: String(body.status ?? ""),
    listing_type_id: String(body.listing_type_id ?? ""),
    variations: Array.isArray(body.variations)
      ? body.variations.map((v: any) => ({ id: Number(v.id), available_quantity: Number(v.available_quantity ?? 0) }))
      : [],
    logistic_type: body.shipping?.logistic_type ?? null,
  };
}

/** Multiget, 20 ids per call. Items ML does not return (not found / error entry) are absent from the map. */
export async function getItemsStock(accountId: string, itemIds: string[], opts: ItemStockOpts = {}): Promise<Map<string, ItemStock>> {
  const auth = opts.auth ?? tokenAuthFor(accountId);
  const out = new Map<string, ItemStock>();
  const ids = [...new Set(itemIds.map((i) => i.toUpperCase()))];
  for (const part of chunks(ids, MULTIGET)) {
    const res = (await mlFetch("GET", `${API}/items`, { query: { ids: part.join(",") }, auth, sleep: opts.sleep })) as any[] | null;
    for (const entry of res ?? []) {
      if (entry?.code !== 200) continue;
      const s = parse(entry.body);
      if (s) out.set(s.itemId, s);
    }
  }
  return out;
}

/** One item; null when ML does not have it. */
export async function getItemStock(accountId: string, itemId: string, opts: ItemStockOpts = {}): Promise<ItemStock | null> {
  return (await getItemsStock(accountId, [itemId], opts)).get(itemId.toUpperCase()) ?? null;
}
