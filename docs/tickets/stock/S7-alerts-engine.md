# S7 — Alerts engine and coverage forecast

## Goal
One place that raises, lists, acknowledges and resolves every alert (new stock alerts + the four existing data-quality alerts), plus the days-of-coverage forecast.

## Files you own
`src/server/stock/alerts.ts`, `src/server/stock/forecast.ts`, `src/server/store/stockAlerts.ts`, `src/server/api/routers/stock-alerts.ts`, tests.

## Behaviour

1. **`raiseAlert(input)`** (interface from S0): upsert by `(accountId, dedupeKey)` while status ≠ `resolved`; a resolved alert may be re-raised later as a new row. Re-raising an acknowledged alert keeps it acknowledged.
2. **Evaluator** `evaluateAlerts(accountId)` (called after movements and by the reconcile; cheap, set-based SQL):
   - `out_of_stock`: `onHand ≤ 0` and at least one active link.
   - `negative_stock`: `onHand < 0`. Detail text asks the user to check whether the migration from ML is complete before correcting.
   - `low_stock`: coverage days below `stockCriticoDias` (7) → severity critical, below `stockBajoDias` (15) → warning (values from `config/business.json`), **or** `onHand < minUnits` when the product has one.
   - `margin_drop`: after a cost change (`ProductCostEntry` newer than the last evaluation), if the product's last-30-day average unit price implies margin below the previous margin by more than 5 points. Dedupe per product.
   - `push_failed`, `stock_drift`, `unmatched_sale`, `link_cost_review`: raised by S3/S4/S5; you only render and resolve them. Auto-resolve when the condition clears (drift gone, push ok).
   - Existing data-quality alerts: reimplement as `suggested_match`, `auto_match`, `missing_cost`, `unmatched_listing` fed by the same sources the dashboard uses today (`MatchDecision`, matcher output, `missingCosts` logic in `src/lib/dashboard-math.ts`, listings with no link). Read from the store; do not edit `dashboard-math.ts`.
3. **Forecast** `coverage(accountId, productId)` (pure + store read), moved from `computeStock` semantics: `rate` = units/day this month (from ledger `sale` movements), falling back to previous-month rate; `coverageDays = onHand / rate`; `breakDate = today + coverageDays`; `reorderUnits = max(0, rate × reposicionDias − max(onHand,0))`. This is a forecast of the stock movement; expose it so S5's `ProductRow` can use it.
4. **Router** `stock-alerts.ts`: `list` (by type, status, product), `counts` (open by type + total; used by the dashboard badge), `acknowledge`, `resolve({id, resolution})`, `decideMatch` (wraps the existing `decideMatch` for suggested/auto matches: confirm / reject / undo). Actions that need data (unmatched listing, missing cost) return a typed "form spec" (`fields`, `submit`) so U3 can render the resolution form; the actual write goes through S5 (`link`, `create`) or S1 (cost entry).

## Tests
Dedupe/ack/resolve lifecycle; each evaluator condition with a fixture; auto-resolve; forecast math vs the old `computeStock` on the same inputs (parity test); counts.

## Done when
Tests green; `counts` is cheap (< 20 ms on 5k products in a test).
