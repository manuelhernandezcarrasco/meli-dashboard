import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./tokens", () => ({
  tokenAuthFor: () => ({ getAccessToken: () => Promise.resolve("tok"), refresh: () => Promise.resolve() }),
}));
vi.mock("~/server/db", () => ({ db: {} }));

import { ReadOnlyViolationError, mlFetch } from "./http";
import { MlMarketClient, sameProductTitle, type NicknameCache } from "./market";

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
        results: Array.from({ length: n }, (_, i) => ({ item_id: `MLA${off + i}`, seller_id: 1000 + ((off + i) % 3) })),
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

  it("chunks multiget by 20, flags isOurs, drops inactive and priceless", async () => {
    const f = fakeMl(45, { inactive: ["MLA2"] });
    vi.stubGlobal("fetch", f);
    const { catalogTitle, points } = await new MlMarketClient("u", noSleep, memCache().cache).fetchMarketPoints("CAT1", 1001);
    const multigets = f.mock.calls.filter((c) => new URL(c[0]).pathname === "/items");
    expect(multigets).toHaveLength(3);
    expect(multigets.every((c) => new URL(c[0]).searchParams.get("ids")!.split(",").length <= 20)).toBe(true);
    expect(catalogTitle).toBe("Catalog Thing");
    expect(points).toHaveLength(43); // 45 - paused MLA2 - price 0 MLA1
    expect(points.find((p) => p.itemId === "MLA2")).toBeUndefined();
    expect(points.every((p) => p.isOurs === (p.sellerId === 1001))).toBe(true);
    expect(points.some((p) => p.isOurs)).toBe(true);
    expect(points[0]!.sellerNickname).toMatch(/^nick/);
  });

  it("nickname cache hit avoids the users call", async () => {
    const f = fakeMl(6);
    vi.stubGlobal("fetch", f);
    const { cache, m } = memCache([[1000, "a"], [1001, "b"], [1002, "c"]]);
    const { points } = await new MlMarketClient("u", noSleep, cache).fetchMarketPoints("CAT1", 1);
    expect(f.mock.calls.some((c) => new URL(c[0]).pathname === "/users")).toBe(false);
    expect(points.find((p) => p.sellerId === 1000)!.sellerNickname).toBe("a");
    // second run with cold cache populates it
    const c2 = memCache();
    await new MlMarketClient("u", noSleep, c2.cache).fetchMarketPoints("CAT1", 1);
    expect(c2.m.size).toBe(3);
    expect(m.size).toBe(3);
  });

  it("retries 429 through the http layer", async () => {
    const f = fakeMl(3, { flaky: true });
    vi.stubGlobal("fetch", f);
    const { points } = await new MlMarketClient("u", noSleep, memCache().cache).fetchMarketPoints("CAT1", 1);
    expect(points.length).toBeGreaterThan(0);
  });

  it("a failed chunk fails the whole fetch with status + body", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const p = new URL(url).pathname;
      if (p === "/items") return new Response("forbidden!", { status: 403 });
      return fakeMl(3)(url);
    }));
    await expect(new MlMarketClient("u", noSleep, memCache().cache).fetchMarketPoints("CAT1", 1)).rejects.toThrow(/403.*forbidden!/);
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

describe("competitor discovery by title", () => {
  it("matches the same model and rejects accessories/other models", () => {
    const t = "Auriculares Bluetooth Inalambricos In Ear Sony Wi-c100 Color Negro";
    expect(sameProductTitle(t, "Sony Wi-c100 Auriculares Inalámbricos In Ear Bluetooth Negro")).toBe(true);
    expect(sameProductTitle(t, "Funda Para Auriculares Sony Wh-1000xm4")).toBe(false);
    expect(sameProductTitle(t, "Auriculares Bluetooth Inalambricos In Ear Sony Wi-c200 Negro")).toBe(false);
  });

  it("adds search-only sellers to the catalog offers without duplicating", async () => {
    const base = fakeMl(2);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/sites/MLA/search") {
        return json({
          paging: { total: 3 },
          results: [
            { id: "MLA0", title: "Catalog Thing", price: 10, sold_quantity: 1, permalink: "x", seller: { id: 1000, nickname: "dup" }, catalog_product_id: "CAT1" },
            { id: "MLA999", title: "Catalog Thing nuevo", price: 90, sold_quantity: 40, permalink: "https://x/999", seller: { id: 55, nickname: "rival" } },
            { id: "MLA998", title: "Otra cosa distinta", price: 5, sold_quantity: 1, permalink: "y", seller: { id: 56, nickname: "no" } },
          ],
        });
      }
      return base(url);
    }));
    const { points } = await new MlMarketClient("u", noSleep, memCache().cache).fetchMarketPoints("CAT1", 55);
    const ids = points.map((p) => p.itemId).sort();
    expect(ids).toContain("MLA999");
    expect(ids.filter((i) => i === "MLA0")).toHaveLength(1);
    expect(ids).not.toContain("MLA998");
    expect(points.find((p) => p.itemId === "MLA999")).toMatchObject({ sellerNickname: "rival", soldQuantity: 40, isOurs: true });
  });

  it("falls back to catalog offers when search is forbidden", async () => {
    const base = fakeMl(2);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new URL(url).pathname === "/sites/MLA/search" ? new Response("no", { status: 403 }) : base(url)));
    const { points } = await new MlMarketClient("u", noSleep, memCache().cache).fetchMarketPoints("CAT1", 1);
    expect(points.length).toBeGreaterThan(0);
  });
});
