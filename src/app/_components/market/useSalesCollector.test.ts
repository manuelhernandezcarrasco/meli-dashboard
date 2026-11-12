import { describe, expect, it } from "vitest";

import type { MarketPoint } from "~/lib/market";
import { COLLECT_LIMIT, pickCandidates } from "./useSalesCollector";

const pt = (i: number, over: Partial<MarketPoint> = {}): MarketPoint => ({
  itemId: `MLA${i}`, sellerId: i, sellerNickname: String(i), title: "t", price: i, soldQuantity: null, soldExact: false,
  permalink: `https://articulo.mercadolibre.com.ar/MLA-${i}`, condition: "new", isOurs: false, ...over,
});

describe("pickCandidates", () => {
  it("takes only new competitors, cheapest first, capped", () => {
    const pts = [pt(5), pt(1), pt(3, { condition: "used" }), pt(2, { isOurs: true }), ...Array.from({ length: 40 }, (_, i) => pt(100 + i))];
    const all = pickCandidates(pts, false);
    expect(all).toHaveLength(COLLECT_LIMIT);
    expect(all.slice(0, 2).map((c) => c.itemId)).toEqual(["MLA1", "MLA5"]);
    expect(all.some((c) => c.itemId === "MLA3" || c.itemId === "MLA2")).toBe(false);
  });
  it("onlyUnknown skips listings whose sales are already known", () => {
    const pts = [pt(1, { soldQuantity: 50 }), pt(2)];
    expect(pickCandidates(pts, true).map((c) => c.itemId)).toEqual(["MLA2"]);
    expect(pickCandidates(pts, false)).toHaveLength(2);
  });
  it("ignores the condition filter when no condition is known yet", () => {
    expect(pickCandidates([pt(1, { condition: undefined }), pt(2, { condition: undefined })], false)).toHaveLength(2);
  });
});
