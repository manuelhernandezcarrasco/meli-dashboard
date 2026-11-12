# S1 — Ledger and weighted-average costing

## Goal
The only code allowed to change stock or cost. Event in → movement row + `onHand` + cost history, atomically and idempotently.

## Files you own
`src/server/stock/ledger.ts`, `src/server/stock/costing.ts`, `src/server/store/stockLedger.ts`, tests `src/server/stock/ledger.test.ts`, `costing.test.ts`, and your section of `src/server/store/store.test.ts` (new file `stockLedger.test.ts` is preferred to avoid conflicts).

## Behaviour

1. **`appendMovement(input)`** — one DB transaction: lock the product row (`SELECT … FOR UPDATE`), insert `StockMovement` with `onHandAfter`, update `InventoryProduct.onHand` (and `inRepair` for `repair_in/out`), insert `ProductCostEntry` when the cost changes. Unique `idempotencyKey` per account: a repeat returns the original result and changes nothing.
2. **Weighted average** (pure, in `costing.ts`): `newCost = (max(onHand,0)·oldCost + qtyIn·landedUnitCost) / (max(onHand,0) + qtyIn)`. If `onHand ≤ 0` before the purchase, `newCost = landedUnitCost`. Negative on-hand never contributes weight. Round to 4 decimals (`Decimal`, never `number`).
3. **Sale movements** do not change cost; they record `unitCostAfter` = cost at that time.
4. **`costAt(accountId, productId, at)`** — latest `ProductCostEntry` with `effectiveFrom ≤ at`; used by S6 to freeze COGS. Returns `null` if none.
5. **Cost reset** (`excel_reset`, and `initial_count`): sets cost to the given value and, for `excel_reset`, writes a stock-correction movement of `(newStock − onHand)`. Both go in the log with `reason` text saying that the Excel set cost and stock.
6. **Negative stock allowed**; calling `raiseAlert({type: 'negative_stock', …})` (interface from S0) is the caller's job, but `appendMovement` returns `wentNegative: true`.
7. **Manual adjust** requires a `reason` (throw if empty). `loss` also requires one.
8. **`availableQuantity(components)`** (pure): `min over c of floor(max(c.onHand,0) / c.quantity)`; empty list → 0.
9. Reads: `listMovements(accountId, productId, {limit, before})`, `getProductBalance`, `recomputeOnHand(accountId, productId)` (sum of movements; used by a consistency test and by an admin repair path — must equal the cache).

## Tests (write first)
Weighted average with the invoice example: 58 units at 55.095,86 × feeFactor 1,27001 → 69.971,74 per unit; second purchase blends with existing stock; purchase while stock is 0 and while negative; idempotent replay; concurrent appends on the same product (two promises, final `onHand` correct); `recomputeOnHand == onHand` after a random sequence of 200 movements; `excel_reset` writes both entries.

## Done when
All above pass against a real test DB; no other file writes to `StockMovement`/`ProductCostEntry`/`InventoryProduct.onHand|unitCost`.
