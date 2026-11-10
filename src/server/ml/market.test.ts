import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./tokens", () => ({
  tokenAuthFor: () => ({ getAccessToken: () => Promise.resolve("tok"), refresh: () => Promise.resolve() }),
}));
vi.mock("~/server/db", () => ({ db: {} }));

import { ReadOnlyViolationError, mlFetch } from "./http";
import { MlMarketClient, type NicknameCache } from "./market";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const memCache = (init: [number, string][] = []) => {
  const m = new Map(init);
  const cache: NicknameCache = {
    get: (ids) => Promise.resolve(new Map(ids.filter((i) => m.has(i)).map((i) => [i, m.get(i)!]))),
    set: (es) => {
      es.forEach(([i, n]) => m.set(i, n));
      return Promise.resolve();
    },
  };
  return { cache, m };
};
const noSleep = () => Promise.resolve();

function fakeMl(total: number, opts: { inactive?: string[]; flaky?: boolean } = {}) {
  let flaked = false;
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    const p = u.pathname;
    if (p === "/products/CAT1") return json({ name: "Catalog Thing" });
    if (p === "/products/CAT1/items") {
      const off = Number(u.searchParams.get("offset"));
      const n = Math.max(0, Math.min(50, total - off));
      return json({
        paging: { total, offset: off, limit: 50 },
        results: Array.from({ length: n }, (_, i) => ({ item_id: `MLA${off + i}`, seller_id: 1000 + ((off + i) % 3), price: off + i === 1 ? 0 : 100 + i })),
      });
    }
    if (p === "/items") {
      if (opts.flaky && !flaked) {
        flaked = true;
        return new Response("slow down", { status: 429 });
      }
      const ids = u.searchParams.get("ids")!.split(",");
      return json(
        ids.map((id) => ({
          code: 200,
          body: {
            id,
            title: `t ${id}`,
            price: id === "MLA1" ? 0 : 100,
            sold_quantity: 7,
            permalink: `https://x/${id}`,
            status: opts.inactive?.includes(id) ? "paused" : "active",
            seller_id: 1000 + (Number(id.slice(3)) % 3),
          },
        })),
      );
    }
    if (p === "/users") {
      return json(u.searchParams.get("ids")!.split(",").map((id) => ({ code: 200, body: { id: Number(id), nickname: `nick${id}` } })));
    }
    return new Response("{}", { status: 404 });
  });
}

describe("MlMarketClient", () => {
  it("paginates offers across pages and caps at 1000", async () => {
    const f = fakeMl(1200);
    vi.stubGlobal("fetch", f);
    const offers = await new MlMarketClient("u", noSleep, memCache().cache).listCatalogOffers("CAT1");
    expect(offers).toHaveLength(1000);
    const offs = f.mock.calls.filter((c) => new URL(c[0]).pathname.endsWith("/items")).map((c) => new URL(c[0]).searchParams.get("offset"));
    expect(offs).toHaveLength(20);
    expect(offs[1]).toBe("50");
  });

  it("builds other sellers' points from the offer alone and only multigets our own items", async () => {
    const f = fakeMl(45, { inactive: ["MLA2"] });
    vi.stubGlobal("fetch", f);
    const { catalogTitle, points } = await new MlMarketClient("u", noSleep, memCache().cache).fetchMarketPoints("CAT1", 1001);
    const multigets = f.mock.calls.filter((c) => new URL(c[0]).pathname === "/items");
    // ours = MLA1, 4, 7, ... (15 items, MLA1 has price 0) -> one chunk of <= 20 ids, all ours
    expect(multigets).toHaveLength(1);
    const asked = new URL(multigets[0]![0]).searchParams.get("ids")!.split(",");
    expect(asked.every((id) => 1000 + (Number(id.slice(3)) % 3) === 1001)).toBe(true);
    expect(catalogTitle).toBe("Catalog Thing");
    expect(points.every((p) => p.isOurs === (p.sellerId === 1001))).toBe(true);
    const theirs = points.filter((p) => !p.isOurs);
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((p) => p.soldQuantity === null && p.price > 0 && p.permalink.startsWith("https://articulo.mercadolibre.com.ar/MLA-"))).toBe(true);
    expect(points.find((p) => p.itemId === "MLA1")).toBeUndefined(); // priceless
    expect(points.find((p) => p.itemId === "MLA4")).toMatchObject({ isOurs: true, soldQuantity: 7 });
  });

  it("nickname cache is only used for our own sellers", async () => {
    const f = fakeMl(6);
    vi.stubGlobal("fetch", f);
    const { cache } = memCache([[1001, "mine"]]);
    const { points } = await new MlMarketClient("u", noSleep, cache).fetchMarketPoints("CAT1", 1001);
    expect(f.mock.calls.some((c) => new URL(c[0]).pathname === "/users")).toBe(false);
    expect(points.find((p) => p.isOurs)!.sellerNickname).toBe("mine");
    expect(points.find((p) => !p.isOurs)!.sellerNickname).toMatch(/^100[02]$/);
  });

  it("retries 429 through the http layer", async () => {
    const f = fakeMl(3, { flaky: true });
    vi.stubGlobal("fetch", f);
    const { points } = await new MlMarketClient("u", noSleep, memCache().cache).fetchMarketPoints("CAT1", 1001);
    expect(points.length).toBeGreaterThan(0);
  });

  it("a failed own-items chunk fails the whole fetch with status + body", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const p = new URL(url).pathname;
      if (p === "/items") return new Response("forbidden!", { status: 403 });
      return fakeMl(3)(url);
    }));
    await expect(new MlMarketClient("u", noSleep, memCache().cache).fetchMarketPoints("CAT1", 1001)).rejects.toThrow(/403.*forbidden!/);
  });

  it("getCatalogProductId returns null when absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.includes("MLA1") ? { catalog_product_id: "CAT9" } : { catalog_product_id: null })));
    const c = new MlMarketClient("u", noSleep, memCache().cache);
    expect(await c.getCatalogProductId("MLA1")).toBe("CAT9");
    expect(await c.getCatalogProductId("MLA2")).toBeNull();
  });

  it("non-GET still throws ReadOnlyViolationError", async () => {
    await expect(mlFetch("POST", "https://api.mercadolibre.com/items/MLA1")).rejects.toBeInstanceOf(ReadOnlyViolationError);
  });
});
