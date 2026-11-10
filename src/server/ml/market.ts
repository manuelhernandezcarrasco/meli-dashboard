import { Prisma } from "../../../generated/prisma";
import { toNum } from "~/lib/normalize";
import { db } from "~/server/db";
import { mlFetch, type MlFetchOpts } from "./http";
import { tokenAuthFor } from "./tokens";

const API = "https://api.mercadolibre.com";
const PAGE = 50;
const MAX_OFFERS = 1000;
const MULTIGET = 20;
const CONCURRENCY = 5;

/**
 * Mirrors `MarketPoint` from MARKET-CONTRACTS.md. Kept structural here so this module does
 * not depend on `src/lib/market.ts` (T8); the shapes are identical.
 */
export type MarketPoint = {
  itemId: string;
  sellerId: number;
  sellerNickname: string;
  title: string;
  price: number;
  soldQuantity: number;
  soldExact: boolean;
  permalink: string;
  isOurs: boolean;
};

export interface SearchHit {
  itemId: string;
  sellerId: number;
  sellerNickname: string | null;
  title: string;
  price: number;
  soldQuantity: number;
  permalink: string;
  sameCatalog: boolean;
}

export interface Offer {
  itemId: string;
  sellerId: number | null;
}

const SEARCH_SITE = "MLA";
const SEARCH_PAGE = 50;
const SEARCH_MAX = 400;

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const tokensOf = (s: string) => fold(s).split(/[^a-z0-9]+/).filter((t) => t.length > 1);

/**
 * Does a public listing title describe the same product as the catalog title? Every token that
 * mixes letters and digits (model codes such as "wi-c100") must appear, and at least 60% of all
 * tokens must. Keeps cases/accessories and other models out of a "same product" comparison.
 */
export function sameProductTitle(catalogTitle: string, listingTitle: string): boolean {
  const want = [...new Set(tokensOf(catalogTitle))];
  if (want.length === 0) return false;
  const have = new Set(tokensOf(listingTitle));
  const hasModel = (t: string) => /[a-z]/.test(t) && /\d/.test(t);
  // "wi-c100" is split into "wi" + "c100"; the digit-bearing piece is the model code.
  if (!want.filter(hasModel).every((t) => have.has(t))) return false;
  return want.filter((t) => have.has(t)).length / want.length >= 0.6;
}

/** Nickname cache; default is the per-owner `ApiCache` table under `seller:<id>`. */
export interface NicknameCache {
  get(ids: number[]): Promise<Map<number, string>>;
  set(entries: [number, string][]): Promise<void>;
}

export function apiCacheNicknames(ownerId: string): NicknameCache {
  return {
    async get(ids) {
      const rows = await db.apiCache.findMany({
        where: { ownerId, key: { in: ids.map((i) => `seller:${i}`) } },
      });
      return new Map(
        rows.flatMap((r) => (typeof r.value === "string" ? [[Number(r.key.slice(7)), r.value] as const] : [])),
      );
    },
    async set(entries) {
      await db.$transaction(
        entries.map(([id, nick]) =>
          db.apiCache.upsert({
            where: { ownerId_key: { ownerId, key: `seller:${id}` } },
            create: { ownerId, key: `seller:${id}`, value: nick as Prisma.InputJsonValue },
            update: { value: nick as Prisma.InputJsonValue },
          }),
        ),
      );
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Runs `fn` over `xs` with at most `limit` in flight; rejects on the first failure. */
async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}

/** Read-only client for the public-catalog side of Mercado Libre (all calls via mlFetch). */
export class MlMarketClient {
  private readonly auth;

  constructor(
    ownerId: string,
    private readonly sleep?: MlFetchOpts["sleep"],
    private readonly nicknames: NicknameCache = apiCacheNicknames(ownerId),
  ) {
    this.auth = tokenAuthFor(ownerId);
  }

  private get(url: string, query?: Record<string, string | number>) {
    return mlFetch("GET", url, { query, auth: this.auth, sleep: this.sleep });
  }

  async getCatalogProductId(itemId: string): Promise<string | null> {
    const r = (await this.get(`${API}/items/${encodeURIComponent(itemId)}`, {
      attributes: "id,catalog_product_id",
    })) as any;
    const id = r?.catalog_product_id;
    return typeof id === "string" && id ? id : null;
  }

  /** Every offer (item id + seller) of a catalog product, paginated, hard-capped at 1000. */
  async listCatalogOffers(catalogProductId: string): Promise<Offer[]> {
    const out: Offer[] = [];
    let offset = 0;
    while (out.length < MAX_OFFERS) {
      const r = (await this.get(`${API}/products/${encodeURIComponent(catalogProductId)}/items`, {
        limit: PAGE,
        offset,
      })) as any;
      const res: any[] = r?.results ?? [];
      for (const o of res) {
        const itemId = o?.item_id ?? o?.id;
        if (typeof itemId !== "string") continue;
        out.push({ itemId, sellerId: o.seller_id != null ? toNum(o.seller_id) : null });
      }
      const total = toNum(r?.paging?.total);
      offset += PAGE;
      if (res.length === 0 || offset >= total) break;
    }
    return out.slice(0, MAX_OFFERS);
  }

  /**
   * Public listings found by title (any seller, catalog or not). Failures (e.g. the search
   * endpoint being closed to this app) yield [] so the catalog offers still work.
   */
  async searchListings(query: string, catalogProductId: string): Promise<SearchHit[]> {
    const out: SearchHit[] = [];
    try {
      for (let offset = 0; offset < SEARCH_MAX; offset += SEARCH_PAGE) {
        const r = (await this.get(`${API}/sites/${SEARCH_SITE}/search`, {
          q: query,
          limit: SEARCH_PAGE,
          offset,
        })) as any;
        const res: any[] = r?.results ?? [];
        for (const o of res) {
          if (typeof o?.id !== "string" || o?.seller?.id == null) continue;
          out.push({
            itemId: o.id,
            sellerId: toNum(o.seller.id),
            sellerNickname: typeof o.seller.nickname === "string" ? o.seller.nickname : null,
            title: String(o.title ?? ""),
            price: toNum(o.price),
            soldQuantity: toNum(o.sold_quantity),
            permalink: String(o.permalink ?? ""),
            sameCatalog: o.catalog_product_id === catalogProductId,
          });
        }
        if (res.length < SEARCH_PAGE || offset + SEARCH_PAGE >= toNum(r?.paging?.total)) break;
      }
    } catch {
      /* search unavailable: fall back to catalog offers only */
    }
    return out;
  }

  private async catalogTitle(catalogProductId: string): Promise<string> {
    const r = (await this.get(`${API}/products/${encodeURIComponent(catalogProductId)}`)) as any;
    return typeof r?.name === "string" ? r.name : catalogProductId;
  }

  private async resolveNicknames(ids: number[]): Promise<Map<number, string>> {
    const known = await this.nicknames.get(ids);
    const missing = ids.filter((i) => !known.has(i));
    const fresh: [number, string][] = [];
    const got = await mapLimit(chunks(missing, MULTIGET), CONCURRENCY, async (part) => {
      const r = (await this.get(`${API}/users`, { ids: part.join(",") })) as any[] | null;
      return r ?? [];
    });
    for (const u of got.flat()) {
      const body = u?.body ?? u;
      if (body?.id != null && typeof body.nickname === "string") {
        fresh.push([toNum(body.id), body.nickname]);
      }
    }
    if (fresh.length) {
      await this.nicknames.set(fresh);
      for (const [id, n] of fresh) known.set(id, n);
    }
    return known;
  }

  async fetchMarketPoints(
    catalogProductId: string,
    ourSellerId: number,
  ): Promise<{ catalogTitle: string; points: MarketPoint[] }> {
    const [catalogTitle, offers] = await Promise.all([
      this.catalogTitle(catalogProductId),
      this.listCatalogOffers(catalogProductId),
    ]);
    const searched = (await this.searchListings(catalogTitle, catalogProductId)).filter(
      (h) => h.price > 0 && (h.sameCatalog || sameProductTitle(catalogTitle, h.title)),
    );
    const known = new Set(searched.map((h) => h.itemId));
    const ids = [...new Set(offers.map((o) => o.itemId))].filter((i) => !known.has(i));
    const bodies = (
      await mapLimit(chunks(ids, MULTIGET), CONCURRENCY, async (part) => {
        const r = (await this.get(`${API}/items`, {
          ids: part.join(","),
          attributes: "id,title,price,sold_quantity,permalink,status,seller_id",
        })) as any[] | null;
        return (r ?? []).map((x) => x?.body).filter((b) => b?.id) as any[];
      })
    ).flat();

    const live = bodies.filter((b) => b.status === "active" && toNum(b.price) > 0);
    const sellerIds = [
      ...new Set([...live.map((b) => toNum(b.seller_id)), ...searched.filter((h) => !h.sellerNickname).map((h) => h.sellerId)]),
    ];
    const nicks = await this.resolveNicknames(sellerIds);

    const fromCatalog = live.map((b): MarketPoint => {
      const sellerId = toNum(b.seller_id);
      return {
        itemId: String(b.id),
        sellerId,
        sellerNickname: nicks.get(sellerId) ?? String(sellerId),
        title: String(b.title ?? ""),
        price: toNum(b.price),
        // TODO(spike): confirm whether sold_quantity is exact for other sellers' items
        // (see T9-findings.md); until then it is reported as exact.
        soldQuantity: toNum(b.sold_quantity),
        soldExact: true,
        permalink: String(b.permalink ?? ""),
        isOurs: sellerId === ourSellerId,
      };
    });
    const fromSearch = searched.map((h): MarketPoint => ({
      itemId: h.itemId,
      sellerId: h.sellerId,
      sellerNickname: h.sellerNickname ?? nicks.get(h.sellerId) ?? String(h.sellerId),
      title: h.title,
      price: h.price,
      soldQuantity: h.soldQuantity,
      soldExact: true,
      permalink: h.permalink,
      isOurs: h.sellerId === ourSellerId,
    }));
    const points = [...fromCatalog, ...fromSearch];
    return { catalogTitle, points };
  }
}
