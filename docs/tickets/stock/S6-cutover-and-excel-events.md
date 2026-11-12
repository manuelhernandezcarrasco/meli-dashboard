# S6 — Cutover import, Excel upload as events, ledger COGS

## Goal
Start the ledger from the current P&L workbook, make later Excel uploads cost+stock events, and make new sales use the frozen ledger cost.

## Files you own
`src/server/stock/cutover.ts`, `src/server/store/stockCutover.ts`, `src/server/workbooks/store.ts` (only the hook points described below), `src/server/calc/lines.ts` (only `costFor`, see 3), `src/server/sync/run.ts` (only to pass the cost lookup in), tests, `src/server/api/routers/stock-products.ts` is **not** yours (S5) — expose cutover through a new `src/server/api/routers/stock-cutover.ts` registered by you in `root.ts` (one-line edit, report it).

## Behaviour

1. **Cutover** `runCutover(accountId, {cutoverAt})` (one-time, explicit button): requires a `Product` snapshot (an uploaded pnl). For each `Product` row: create `InventoryProduct` (ean, name = description, model, category, unitCost) and, through S1, an `initial_count` movement of `stockFinal` plus a `ProductCostEntry` (`reason: initial`) with cost `unitCost`. Set `InventorySettings.cutoverAt`. Idempotent: re-running does nothing for existing products; a second run with different `cutoverAt` is refused.
2. **Then `autoLink`** (S5) so exact-GTIN listings link immediately. Report counts (products created, listings linked, listings left unlinked).
3. **Excel after cutover** (hook in `saveUpload`): if `cutoverAt` is set and a `pnl` file arrives, **do not** treat it as the stock/cost source silently. For each EAN present in an existing `InventoryProduct`: write `excel_reset` through S1 (cost = CU Pond., stock = Stock final) with `reason: "Excel <file> <date>: costo y stock"`, effective at upload time. New EANs create products as in (1). The legacy tables (`Product`, etc.) keep being written for pre-cutover history exactly as today. An `inputs` upload's `Ingresos Stock` sheet is **ignored for stock after cutover** (invoices replace it) and the UI says so; its sales sheets keep working.
4. **Ledger COGS** (`costFor`): for a sale at or after `cutoverAt` where the EAN resolves to an `InventoryProduct`, use `costAt(accountId, productId, saleInstant)` (S1) with label `Ledger (costo ponderado)`. Otherwise today's resolution order is unchanged. `Override` sheet still applies to pre-cutover sales only. `SaleLine.costSource` documents which was used. `rebuildAll` must therefore never change a frozen cost: add a test that rebuilding twice gives identical COGS.
5. **Dashboard stock section** is removed by U0; make sure `computeStock` stays callable (S7 reuses the rate/coverage math) — do not delete it.

## Tests
Cutover on a fixture workbook (counts, movements, costs); idempotency; second cutoverAt refused; Excel upload after cutover writes `excel_reset` with the log text; `costFor` picks the cost in effect at sale time (sale before and after an invoice's cost change); rebuild stability.

## Done when
Tests green; `docs/database/README.md` "Who writes what" has your rows; the dashboard renders for a pre-cutover and a post-cutover account.
