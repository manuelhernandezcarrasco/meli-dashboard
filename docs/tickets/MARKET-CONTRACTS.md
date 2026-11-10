# Market research — shared contracts (read by T8–T13)

Feature: for one of our products that has a `catalog_product_id`, plot every seller's offer for that catalog product as a scatter (X = price, Y = units sold), with a best-fit line, our own offers highlighted. Products without a catalog id are **out of scope** (show "not supported yet").

These types live in `src/lib/market.ts` (created by T8, copied verbatim from here). Every ticket codes against them; nobody changes them without updating this file in the same PR.

```ts
export type MarketPoint = {
  itemId: string;          // MLA…
  sellerId: number;
  sellerNickname: string;
  title: string;
  price: number;           // ARS
  soldQuantity: number;    // exact if soldExact, else lower bound of ML bucket ("+100" -> 100)
  soldExact: boolean;
  permalink: string;
  isOurs: boolean;         // sellerId === our ML user id
};

export type RegressionMode = "log" | "linear";
export type Regression = { mode: RegressionMode; slope: number; intercept: number; r2: number; n: number };

export type MarketResearch = {
  catalogProductId: string;
  catalogTitle: string;
  points: MarketPoint[];             // outliers already removed, capped (see T8)
  excluded: { point: MarketPoint; reason: "price_outlier" | "sales_outlier" | "cap" }[];
  regression: { log: Regression | null; linear: Regression | null }; // null when n < 3
  fetchedAt: string;                 // ISO, when ML data was pulled
};

export type MarketState =
  | { status: "none" }                                            // never researched
  | { status: "running"; data: MarketResearch | null; startedAt: string } // data = previous result, if any
  | { status: "ready"; data: MarketResearch }
  | { status: "failed"; data: MarketResearch | null; error: string };

export const MARKET_TTL_MS = 15 * 60_000;   // staleness + client re-poll interval
export const MARKET_MAX_SELLERS = 500;      // cap applied in T8
```

## tRPC router `market` (owned by T12, consumed by T13 / T11)
- `market.get({ catalogProductId }): MarketState` — read-only, returns the stored state, never triggers ML calls.
- `market.touch({ catalogProductId }): MarketState` — **the only trigger.** If no result exists, or `now - fetchedAt > MARKET_TTL_MS`, and no job is running for that (owner, catalog id), start a background job and return `running`. Otherwise return the current state untouched. Idempotent: calling it N times concurrently starts at most one job.
- `market.searchOwnProducts({ query }): { itemId; title; catalogProductId: string | null }[]` — owned by T11. Case/accent-insensitive title match over our products (from the latest `Snapshot`), max 10 results.
- `market.catalogIdForItem({ itemId }): { catalogProductId: string | null }` — owned by T11.

## Refresh policy (the user's rules)
1. Opening the page (`/market-research/[catalogProductId]`) calls `touch` once. Server refreshes only if missing or older than 15 min.
2. While the page stays mounted, the client calls `touch` every 15 min (and polls `get` every 2 s only while `status === "running"`).
3. When the page is unmounted nothing refreshes. There is no cron, no server-side timer.
4. While `running` with previous data, the UI keeps showing the previous data plus an "updating…" indicator.
5. Persistence: new Prisma model `MarketResearch { ownerId, catalogProductId, payload Json, fetchedAt DateTime, @@id([ownerId, catalogProductId]) }` (T12 adds the migration). In-flight job tracking is in-process (same approach as `rebuild`/`rebuildStatus` in `src/server/sync`).

## Read-only rule
All ML calls go through `src/server/ml/http.ts` (GET only, `api.mercadolibre.com`). Do not add a second network path.
