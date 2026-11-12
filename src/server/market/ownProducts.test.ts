import { describe, expect, it, vi } from "vitest";

import {
  cachedCatalogId, collectOwnProducts, normalizeText, searchOwnProducts,
  type CatalogStore, type OwnProduct,
} from "./ownProducts";

const memCache = (): CatalogStore & { store: Map<string, string | null> } => {
  const store = new Map<string, string | null>();
  return {
    store,
    get: (o, id) => Promise.resolve(store.get(`${o}|${id}`)),
    set: (o, id, v) => { store.set(`${o}|${id}`, v); return Promise.resolve(); },
  };
};
const setup = (products: OwnProduct[], ids: Record<string, string | null> = {}) => {
  const lookup = vi.fn((_o: string, itemId: string) => Promise.resolve(ids[itemId] ?? null));
  const cache = memCache();
  return { lookup, cache, deps: { ownerId: "u1", lookup, cache, products } };
};

describe("normalizeText", () => {
  it("lowercases and strips accents", () => expect(normalizeText("  CÁMARA Réflex ")).toBe("camara reflex"));
});

describe("collectOwnProducts", () => {
  it("dedupes by item id across the snapshot lists", () => {
    const p = { itemId: "MLA1", title: "A", ean: "", desc: "", score: 1, qty: 1, venta: 1 };
    const out = collectOwnProducts({
      autoMatches: [p],
      suggestions: [{ ...p, title: "dup" }],
      unmatched: [{ itemId: "MLA2", sku: "", title: "B", qty: 1, venta: 1 }],
    });
    expect(out).toEqual([{ itemId: "MLA1", title: "A" }, { itemId: "MLA2", title: "B" }]);
  });
});

describe("searchOwnProducts", () => {
  it("matches case- and accent-insensitively", async () => {
    const { deps } = setup([{ itemId: "MLA1", title: "Cámara Sony Alpha" }, { itemId: "MLA2", title: "Vino" }], { MLA1: "MLA-C1" });
    expect(await searchOwnProducts(deps, "CAMARA sony")).toEqual([
      { itemId: "MLA1", title: "Cámara Sony Alpha", catalogProductId: "MLA-C1" },
    ]);
  });

  it("caps at 10 results and ignores empty queries", async () => {
    const products = Array.from({ length: 25 }, (_, i) => ({ itemId: `MLA${i}`, title: `Taladro ${i}` }));
    const { deps } = setup(products);
    expect(await searchOwnProducts(deps, "taladro")).toHaveLength(10);
    expect(await searchOwnProducts(deps, "  ")).toEqual([]);
  });

  it("returns null catalogProductId when the item has none", async () => {
    const { deps } = setup([{ itemId: "MLA1", title: "Taladro" }]);
    expect((await searchOwnProducts(deps, "tala"))[0]?.catalogProductId).toBeNull();
  });
});

describe("cachedCatalogId", () => {
  it("looks up once and remembers the answer, nulls included", async () => {
    const { deps, lookup, cache } = setup([], { MLA1: "MLA-C1" });
    expect(await cachedCatalogId(deps, "MLA1")).toBe("MLA-C1");
    expect(await cachedCatalogId(deps, "MLA1")).toBe("MLA-C1");
    expect(await cachedCatalogId(deps, "MLA9")).toBeNull();
    expect(await cachedCatalogId(deps, "MLA9")).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(cache.store.get("u1|MLA1")).toBe("MLA-C1");
    expect(cache.store.get("u1|MLA9")).toBeNull();
  });

  it("does not cache lookup failures", async () => {
    const { deps, cache, lookup } = setup([]);
    lookup.mockRejectedValueOnce(new Error("boom"));
    await expect(cachedCatalogId(deps, "MLA1")).rejects.toThrow("boom");
    expect(cache.store.size).toBe(0);
  });
});
