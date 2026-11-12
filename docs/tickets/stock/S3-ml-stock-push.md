# S3 — ML stock write + push engine

## Goal
The only code that writes to Mercado Libre. Reads ML stock, pushes our available quantity, in dry-run by default, with a full log.

## Files you own
`src/server/ml/stock-write.ts`, `src/server/ml/http.ts` (only the guard change below), `src/server/ml/http.test.ts` (extend), `src/server/ml/items-stock.ts` (read helpers), `src/server/stock/push.ts`, `src/server/store/stockPush.ts`, tests for each.

## Behaviour

1. **Guard exception.** `mlFetch` stays read-only. Add one explicit, separate function `setAvailableQuantity({itemId, variationId?, quantity})` in `stock-write.ts` that is the *only* path allowed to `PUT https://api.mercadolibre.com/items/{id}` (body: `available_quantity` only; for a variation, `PUT /items/{id}` with `variations: [{id, available_quantity}]`). Extend the guard test: every other method/URL combination still throws `ReadOnlyViolationError`; the new function sends nothing else. Quantity must be an integer ≥ 0.
2. **Reads** (`items-stock.ts`): `getItemStock(itemId)` → `{available_quantity, status, listing_type_id, variations:[{id, available_quantity}], logistic_type}` via `/items?ids=` multiget (20 per call). Reuse the existing GET path.
3. **Skip rules** (result `skipped`, logged, never pushed): listing in ML Full (`logistic_type = fulfillment`); item status not `active`/`paused`; link has no components; any component product missing.
4. **`requestPush(accountId, productIds, trigger)`** (interface from S0): find links whose components include these products; compute `availableQuantity(components)` (S1 pure function; until S1 merges, import it from `contracts` fake and swap); then for each link: if every component's `syncMode` is `live` → call `setAvailableQuantity`, else log `dry_run`. Negative or drifting stock is clamped to `max(0, qty)` for the value but the alert for it is raised by S7 — you only log `requestedQty`.
5. Retries: 3 attempts with backoff on 429/5xx; 4xx (except 429) fail immediately. Update `ListingSyncState` (`lastPushedQty`, `status`, `lastError`). On failure also `raiseAlert({type: 'push_failed', dedupeKey: itemId})`.
6. **Never push 0 for unknown products**: only listings with an explicit `ListingLink` are ever touched.
7. **Drift/reconcile compute**: `compareWithMl(accountId)` reads ML quantities for all linked listings, writes `lastObservedMlQty`, marks `drift` when `ml ≠ ours`, raises `stock_drift` alerts, and (only for live products with no open drift alert and not in the migration-confirm state) calls `requestPush` with trigger `reconcile`. It does **not** overwrite ML for dry-run products. Scheduling is S4.
8. **Go-live helper** `prepareGoLive(accountId, productId)` → returns `{ours, ml: [{itemId, variationId, mlQty}]}` for the UI to show; `setSyncMode(accountId, productIds|'all', mode, confirmedOpeningStock?)` flips the mode only when the opening stock was confirmed/edited (writes an `manual_adjust` via S1 if edited). Exposed to U5 through the `stockSync` router **in your own file** `src/server/api/routers/stock-sync.ts` (S0 created it empty).

## Files you also own
`src/server/api/routers/stock-sync.ts`.

## Tests
Guard (blocked/allowed matrix, payload shape), push in dry-run (nothing sent, log written), live push with mocked fetch, retry/backoff, Full-skip, combo quantity, variation payload, unknown-product never pushed, drift detection.

## Done when
Tests green; grep shows no other `PUT`/`POST`/`PATCH`/`DELETE` to ML anywhere; the app still compiles with live mode unreachable until a product is explicitly switched.
