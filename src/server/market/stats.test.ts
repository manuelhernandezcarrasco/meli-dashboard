import { describe, expect, it } from "vitest";
import { MARKET_MAX_SELLERS, type MarketPoint } from "~/lib/market";
import {
  buildResearch,
  fitLinear,
  fitLog,
  predictLine,
  quantile,
} from "./stats";

let seq = 0;
const pt = (price: number, sold: number, over: Partial<MarketPoint> = {}): MarketPoint => ({
  itemId: `MLA${++seq}`,
  sellerId: seq,
  sellerNickname: `s${seq}`,
  title: "t",
  price,
  soldQuantity: sold,
  soldExact: true,
  permalink: "x",
  isOurs: false,
  ...over,
});
const build = (points: MarketPoint[]) =>
  buildResearch({ catalogProductId: "MLA1", catalogTitle: "T", points, fetchedAt: "2026-01-01T00:00:00Z" });

describe("quantile", () => {
  it("odd n", () => {
    const s = [1, 2, 3, 4, 5];
    expect(quantile(s, 0.25)).toBe(2);
    expect(quantile(s, 0.5)).toBe(3);
    expect(quantile(s, 0.75)).toBe(4);
  });
  it("even n interpolates", () => {
    const s = [1, 2, 3, 4];
    expect(quantile(s, 0.25)).toBeCloseTo(1.75);
    expect(quantile(s, 0.5)).toBeCloseTo(2.5);
    expect(quantile(s, 0.75)).toBeCloseTo(3.25);
  });
});

describe("regression", () => {
  it("perfect line gives r2 = 1", () => {
    const r = fitLinear([pt(12, 1), pt(14, 2), pt(16, 3), pt(18, 4)])!;
    expect(r.slope).toBeCloseTo(2);
    expect(r.intercept).toBeCloseTo(10);
    expect(r.r2).toBeCloseTo(1);
    expect(r.n).toBe(4);
  });
  it("hand-computed small set", () => {
    // x=1,2,3 y=2,3,5 -> slope 1.5, intercept 0.3333, r2 = 0.9643
    const r = fitLinear([pt(2, 1), pt(3, 2), pt(5, 3)])!;
    expect(r.slope).toBeCloseTo(1.5);
    expect(r.intercept).toBeCloseTo(1 / 3);
    expect(r.r2).toBeCloseTo(0.964286, 5);
  });
  it("log mode recovers power-law exponent", () => {
    const pts = [1, 2, 5, 10, 50, 100].map((s) => pt(1000 * Math.pow(s, -0.5), s));
    const r = fitLog(pts)!;
    expect(r.slope).toBeCloseTo(-0.5);
    expect(Math.exp(r.intercept)).toBeCloseTo(1000);
    expect(r.r2).toBeCloseTo(1);
  });
  it("n < 3 and zero X variance give null", () => {
    expect(fitLinear([pt(1, 1), pt(2, 2)])).toBeNull();
    expect(fitLinear([pt(1, 5), pt(2, 5), pt(3, 5)])).toBeNull();
  });
  it("sold = 0 is dropped from log fit only", () => {
    const pts = [pt(10, 0), pt(8, 1), pt(6, 2), pt(5, 4)];
    expect(fitLog(pts)!.n).toBe(3);
    expect(fitLinear(pts)!.n).toBe(4);
  });
  it("predictLine returns original units", () => {
    const lin = predictLine({ mode: "linear", slope: 2, intercept: 10, r2: 1, n: 3 }, 0, 4, 4);
    expect(lin).toHaveLength(5);
    expect(lin[4]).toEqual({ sold: 4, price: 18 });
    const log = predictLine({ mode: "log", slope: -0.5, intercept: Math.log(1000), r2: 1, n: 3 }, 1, 100, 2);
    expect(log[0]!.price).toBeCloseTo(1000);
    expect(log[2]!.price).toBeCloseTo(100);
  });
});

describe("buildResearch", () => {
  const base = () => Array.from({ length: 10 }, (_, i) => pt(100 + i, 10 + i));

  it("removes planted price outlier", () => {
    const out = pt(5000, 14);
    const r = build([...base(), out]);
    expect(r.excluded).toEqual([{ point: out, reason: "price_outlier" }]);
    expect(r.points).toHaveLength(10);
  });
  it("removes planted sales outlier", () => {
    const out = pt(104, 9000);
    const r = build([...base(), out]);
    expect(r.excluded).toEqual([{ point: out, reason: "sales_outlier" }]);
  });
  it("never excludes our own points", () => {
    const mine = pt(5000, 9000, { isOurs: true });
    const r = build([...base(), mine]);
    expect(r.points).toContain(mine);
    expect(r.excluded).toHaveLength(0);
  });
  it("skips fences when n < 8", () => {
    const pts = [pt(100, 10), pt(101, 11), pt(102, 12), pt(5000, 9000)];
    const r = build(pts);
    expect(r.points).toHaveLength(4);
    expect(r.excluded).toHaveLength(0);
  });
  it("cap keeps top sold (ties lower price) and keeps ours", () => {
    const pts = Array.from({ length: MARKET_MAX_SELLERS + 3 }, (_, i) => pt(100 + i, 50));
    const mine = pt(9999, 0, { isOurs: true });
    const r = build([...pts, mine]);
    expect(r.points).toHaveLength(MARKET_MAX_SELLERS);
    expect(r.points).toContain(mine);
    const capped = r.excluded
      .filter((e) => e.reason === "cap")
      .map((e) => e.point.price);
    // 503 equal-sold others + ours: room for 499 others; highest prices dropped
    expect(capped).toHaveLength(4);
    expect(Math.min(...capped)).toBe(100 + MARKET_MAX_SELLERS - 1);
  });
  it("returns null regressions when n < 3", () => {
    const r = build([pt(1, 1), pt(2, 2)]);
    expect(r.regression).toEqual({ log: null, linear: null });
  });
});
