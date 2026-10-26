# T4 — Stock coverage and critical list

**Depends on:** T0 merged · **Blocks:** T6 · **Parallel with:** T1 T2 T3 T5
**Needs DB:** no · **Branch:** `t4-stock`

## Goal
Port `compute_stock` as a pure function, test-first against the Python fixture.

## Files you own
`src/server/calc/stock.ts`, `src/server/calc/stock.test.ts` (only these two).

## Spec
Port `compute_stock` (`legacy/ml_pnl_live.py` 604–662) and the `ESTADOS` order (601):

```ts
export function computeStock(
  base: Base, lines: Line[], inputs: Inputs, cfg: BusinessConfig,
  y: number, m: number, cutDay: number, prevDays: number,
): StockItem[]
```
- Sold units per EAN = Σ qty of lines with `ean` in month `(y, m)` and `day ≤ cutDay`. Inflows = `inputs.ingresos` in the month and `date ≤ cutDate`.
- `remaining = initial + inflow − sold`. Rate = `sold / cutDay`; if `sold` is 0 use `udsPrev / prevDays` and `rateSource "mes anterior"`. Skip SKUs with `rate ≤ 0 && remaining ≤ 0`.
- `coverage = remaining / rate` if `rate > 0 && remaining > 0`; `0` if `remaining ≤ 0`; `null` otherwise. `breakDate = cutDate + floor(coverage) days` (null if coverage is falsy). Round `rate` to 2 and `coverage` to 1 decimals. `reorder = max(0, round(rate × reposicionDias − max(remaining, 0)))`.
- State: `remaining < 0` → "Vendido sin stock"; `== 0` → "Agotado"; `coverage < stockCriticoDias` → "Crítico"; `< stockBajoDias` → "Bajo"; else "OK".
- Sort exactly like the Python: by state order, then (Vendido sin stock: `remaining` asc) / (Agotado: `rate` desc) / `coverage` asc (null last) / `rate` desc. Use `Math.round` carefully: Python `round` is banker's rounding; if a fixture value differs by 1 because of a .5 tie, replicate with a `pyRound` helper and say so in your report.
- Also export `toStockRow(item): StockRow` (compaction used by the dashboard, desc truncated to 60 chars).

## Tests
- Fixture: with `tests/fixtures/demo/{base,lines,inputs,stock}.json`, `cfg` thresholds 7/15/30, `y=2026, m=10, cutDay=20, prevDays=30` → equals `stock.json` (numbers `toBeCloseTo`, strings and order exact).
- Hand cases: sold more than stock → "Vendido sin stock"; stock 0 → "Agotado"; coverage 6.9 → "Crítico", 7 → "Bajo", 15 → "OK"; no sales this month uses the previous-month rate; no rate and no stock is skipped; inflows after the cut day are ignored.

## Acceptance
`pnpm typecheck && pnpm lint && pnpm test` green.

## Out of scope
Anything else under `src/server/calc` (T3 owns it).
