# T3 — P&L calculation core

**Depends on:** T0 merged · **Blocks:** T6 · **Parallel with:** T1 T2 T4 T5
**Needs DB:** no · **Branch:** `t3-pnl-core`

## Goal
Pure functions (no I/O, no `Date.now()` inside) that turn orders + costs + base + inputs into `Line[]`, daily series, the month-vs-previous comparison and the final `DashboardData`. Python is the oracle, so write tests first from the fixtures.

## Files you own
`src/server/calc/*` **except** `stock.ts` (T4), with `index.ts` exporting: `buildLines`, `dailySeries`, `acum`, `calibrateTaxPct`, `unmatchedFrom`, `buildComparison`, `computeDashboard`. Tests next to them.

## Spec (port from `legacy/ml_pnl_live.py`)
1. **`buildLines(orders, shipCosts, gtins, base, inputs, cfg, y, m, taxes?)`** — port of `build_lines` (497–598). Keep every quirk: only `status === "paid"`; shipping cost prorated across orders sharing a `shippingId` by order revenue; real MP taxes when any approved payment has an entry, else `venta × impPct`; EAN resolution order `mapItem` → `mapSku` → `SKU=EAN` (via `normEan(sku)` in base) → GTIN of the listing (variation first, then `_item`); `costFor()` priority: override → base with cu>0 ("Real (CU Pond. cierre)") → base with cu=0 ("Asumido N%") → no match ("Sin match – asumido 30%", cat `SIN MATCH`); an EAN that is not in base nor override forces `cat = "SIN MATCH"`; direct sales (`inputs.va`) of the same month appended with channel `VA`, `matchVia "Carga manual"`, zero ML costs; sort by date, time, channel. Dates via `toArgParts`. `taxDetail` text format `"<name> <amount>"` joined with `"; "`, amounts rounded, thousands separator `.`.
2. **`dailySeries(lines, y, m)`** and **`acum(series, n)`** — port of 1116–1139 (round every value to 2 decimals; `ingNetos`, `margen` derived).
3. **`calibrateTaxPct(prevLines, prevCierre)`** — the `"auto"` branch inside `run_sync` (1263–1278): `max(0, min(0.15, (prevCierre.costoMl − Σ(cargoVenta+envio)) / Σ venta))` over previous-month **ML** lines built with tax pct = 0; returns 0 when there are no prev lines or no `prevCierre.costoMl`. Round to 4 decimals. If `cfg.impuestosMlPctEstimado` is a number use it as is.
4. **`unmatchedFrom(lines)`** — the `um` block (1291–1299): ML lines with `cat === "SIN MATCH"` grouped by `itemId`, sorted by venta desc, max 30.
5. **`buildComparison({...})`** — port of the `comp` block (1301–1334) with **`now` and `cutDay` as parameters** (never call `Date` inside). Includes `prevToday` (previous-month lines of the cut day up to `cutTime`), `prevAccumAtCut`, `prevDaily`, `prevCierre` fallback to `acum(prevDaily)` when `prevCierre.venta` and `.cogs` are 0, and `curDaily`.
6. **`computeDashboard(input) → DashboardData`** — assembles everything per CONTRACTS.md. Input: `{ orders, prevOrders, shipCosts, gtins, taxes, base, prevCierre, inputs, cfg, y, m, now, stockFn }`. `stockFn` is injected (T4 provides `computeStock`) so this ticket does not depend on T4; use a stub in tests that returns `[]`. Row/stock compaction exactly as `write_dashboard` (1079–1099): description truncated to 70 / 60 chars, `assumed` flag, `updatedAt` as `dd/MM/yyyy HH:mm` Argentina time, `monthLabel`, thresholds, `refreshMinutes`, `taxPct`.

## Tests (write first)
- With `tests/fixtures/demo/*.json`: `buildLines(...)` deep-equals `lines.json` (`toBeCloseTo` for numbers, exact for strings/dates); `dailySeries` equals `daily.json`; tax calibration equals the pct used by the Python fixture (read it from `lines.json` imp_fuente "Estimado x%" or add it to the fixture notes).
- Unit cases you build by hand: packs sharing a shipment split cost by revenue; cancelled order ignored; payment with MP taxes → `taxSource "Mercado Pago"`; no payment detail → `"Estimado …"`; override beats base; unknown EAN → `SIN MATCH`; SKU equal to an EAN in base matches via `SKU=EAN`; direct sale from another month ignored.
- `buildComparison`: cut day in the middle of the month with `now` 15:30 only counts previous-month lines up to 15:30; a past month uses the full month.
- `computeDashboard(...)` output validates against `DashboardDataSchema`.

## Acceptance
`pnpm typecheck && pnpm lint && pnpm test` green, no `Date.now()` / `new Date()` without arguments inside `src/server/calc` (`rg "Date\.now|new Date\(\)" src/server/calc` is empty).

## Out of scope
Stock (T4), fetching data (T1/T2/T6), UI.
