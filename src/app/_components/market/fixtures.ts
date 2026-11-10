import type { MarketPoint, MarketResearch } from "~/lib/market";

// Deterministic pseudo-random so the fixture is stable.
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

const rand = rng(42);

function mk(i: number, over: Partial<MarketPoint> = {}): MarketPoint {
  const price = Math.round(40000 + rand() * 60000);
  const sold = Math.max(1, Math.round(Math.exp(9 - 0.75 * Math.log(price / 1000) + (rand() - 0.5) * 1.2)));
  return {
    itemId: `MLA${1000 + i}`,
    sellerId: 5000 + i,
    sellerNickname: `VENDEDOR_${i}`,
    title: "Auriculares Bluetooth Pro X2 Negro",
    price,
    soldQuantity: sold,
    soldExact: i % 3 !== 0,
    permalink: `https://articulo.mercadolibre.com.ar/MLA-${1000 + i}`,
    isOurs: false,
    ...over,
  };
}

const others = Array.from({ length: 58 }, (_, i) => mk(i));
const ours = [
  mk(100, { sellerId: 1, sellerNickname: "MI_TIENDA", price: 62000, soldQuantity: 140, soldExact: true, isOurs: true }),
  mk(101, { sellerId: 1, sellerNickname: "MI_TIENDA", price: 71500, soldQuantity: 60, soldExact: false, isOurs: true }),
];

export const fixtureResearch: MarketResearch = {
  catalogProductId: "MLA12345678",
  catalogTitle: "Auriculares Bluetooth Pro X2",
  points: [...others, ...ours],
  excluded: [
    { point: mk(200, { price: 450000, soldQuantity: 3 }), reason: "price_outlier" },
    { point: mk(201, { price: 55000, soldQuantity: 9000, soldExact: false }), reason: "sales_outlier" },
    { point: mk(202), reason: "cap" },
  ],
  regression: {
    log: { mode: "log", slope: -0.15, intercept: 11.5, r2: 0.62, n: 60 },
    linear: { mode: "linear", slope: -20, intercept: 80000, r2: 0.31, n: 60 },
  },
  fetchedAt: "2026-11-10T12:00:00.000Z",
};
