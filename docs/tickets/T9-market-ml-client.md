# T9 — Market research: Mercado Libre catalog client

**Depends on:** nothing (contracts in MARKET-CONTRACTS.md; reuses existing `src/server/ml/http.ts`) · **Parallel with:** T8 T10 T11 T12 T13 · **Branch:** `t9-market-ml-client`

## Goal
Fetch every offer for a catalog product, with price, sold count, permalink and seller nickname, read-only.

## Files you own
`src/server/ml/market.ts` (+ small additions to `client.ts` only if needed), `src/server/ml/market.test.ts`, `docs/tickets/T9-findings.md`.

## Step 0 — feasibility spike (do first, report in T9-findings.md)
Unauthenticated calls to `/sites/MLA/search`, `/products/{id}/items` and `/items/{id}` return 403, so the app's OAuth token is required. With a real token (user must run it or provide it locally; **never commit or log tokens**), determine:
- which endpoint lists all offers of a `catalog_product_id` (candidates: `GET /products/{id}/items`, `GET /sites/MLA/search?product_id={id}`) and whether it paginates / how many results max;
- whether `sold_quantity` is **exact** or a bucket for items that aren't ours (`GET /items?ids=…` multiget vs search results vs the item page); document exact response fields;
- whether seller nickname comes with the offer or needs `GET /users/{id}` (batch if possible).
If exact counts are unavailable, set `soldExact: false` and `soldQuantity` = bucket lower bound. Write the findings with sample (redacted) responses and **stop and tell the user** if no endpoint works at all.

## Spec
1. `getCatalogProductId(itemId)` → `GET /items/{id}` → `catalog_product_id | null`.
2. `listCatalogOffers(catalogProductId)` → all offers, paginated, bounded (hard stop at 1000 offers).
3. `fetchMarketPoints(catalogProductId, ourSellerId)` → `{catalogTitle, points: MarketPoint[]}`; multiget items in chunks of 20, concurrency ≤ 5 (reuse the existing helper style), nicknames deduped and cached in `ApiCache` under `seller:<id>` (nicknames rarely change; no TTL needed). `isOurs = sellerId === ourSellerId`.
4. Skip inactive/paused listings and offers with no price.
5. Errors: throw with status + first 300 chars of body (as `http.ts` does); a single failed chunk fails the whole fetch (the job reports `failed`, previous data stays).

## Tests (mock `fetch`, injected `sleep`, no real network)
Pagination across pages, chunking by 20, nickname cache hit avoids second call, `isOurs` flag, inactive filtered, 429-retry path via existing http layer, non-GET attempt still throws `ReadOnlyViolationError`.

## Acceptance
`pnpm typecheck && pnpm lint && pnpm test` green; `rg "fetch\(" src/server/ml` still shows only `http.ts`.
