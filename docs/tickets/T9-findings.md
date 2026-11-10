# T9 — Findings

## Step 0 (feasibility spike): NOT RUN — open question
The spike needs a real ML access token. Per instructions no credentials were read from the DB/env.
Unauthenticated calls return 403, so nothing could be verified. **Needs the user to decide** how to run
it (e.g. a one-off local script that reuses the app's token without printing it, then paste the redacted responses here).

Open questions to resolve with a token:
1. Does `GET /products/{id}/items` (paging `limit`/`offset`, results with `item_id`, `seller_id`, `price`) list all offers? Max results / page size? Fallback: `GET /sites/MLA/search?product_id={id}`.
2. Is `sold_quantity` from `GET /items?ids=` exact for other sellers' items, or a bucket (`+100`)? The client currently assumes exact (`soldExact: true`); if bucketed, set `soldExact: false` and use the lower bound in `fetchMarketPoints`.
3. Does `GET /users?ids=a,b,c` (multiget) return nicknames for other sellers? Response parsing accepts both `[{id,nickname}]` and `[{code, body:{id,nickname}}]`.

## Implementation (against mocks)
`src/server/ml/market.ts` exports `MlMarketClient` with `getCatalogProductId`, `listCatalogOffers`, `fetchMarketPoints`.
Assumed endpoints: `/items/{id}`, `/products/{id}`, `/products/{id}/items`, `/items?ids=` (chunks of 20, concurrency 5), `/users?ids=` (chunks of 20).
Nicknames are cached in `ApiCache` as `seller:<id>`. `MarketPoint` is declared locally (identical to the contract) until T8 lands `src/lib/market.ts`.
