# T2 — Workbook readers + demo data source

**Depends on:** T0 merged · **Blocks:** T6, T7 · **Parallel with:** T1 T3 T4 T5
**Needs DB:** no · **Branch:** `t2-workbooks-demo`

## Goal
Read the closing P&L and the manual-input workbook with `exceljs`, and provide a `DemoDataSource` so everything can run without Mercado Libre.

## Files you own
`src/server/workbooks/*` (replace placeholder `index.ts`), `src/server/datasource/demo.ts`, tests next to them. Add `exceljs` with `pnpm add exceljs` (the only new dependency).

## Spec
1. **`readBase(path, cfg)`** — exact port of `read_base` (`legacy/ml_pnl_live.py` 339–414): open the sheet whose normalized name is `pldetalle` or `pyldetalle`; find the header row within the first 25 rows (contains `ean` and a header starting with `cupond`); resolve columns with the same prefix-matching `col()` logic; category rows (no EAN) set the current category; build `Base` (CONTRACTS.md) and the `PrevCierre` totals (sums of `ventaml, ventava, ventatotal, costoml, cogs, ml+va units`; `ingNetos = venta − costoMl`, `margen = ingNetos − cogs`). Read **values, not formulas** (exceljs `cell.result` for formula cells; treat error values as empty). Error messages as in the Python (file missing, sheet missing, header missing).
2. **`readInputs(path)`** — exact port of `read_inputs` (417–494): sheets `Ventas Directas`, `Mapeo ML`, `Costos Override`, `Ingresos Stock`; header row = first of the first 10 rows containing `ean`; skip rows whose `cliente`/`proveedor` starts with `EJEMPLO`; direct sales with no price are ignored (log a warning); dates may be Excel dates or `dd/mm/yyyy` strings → `"YYYY-MM-DD"`. Missing file → empty inputs + warning (do not throw).
3. **`DemoDataSource implements DataSource`** (`demo.ts`): port the *idea* of `demo_orders` (1542–1580) and `demo_taxes` (1583–1602): plausible fake orders built from the `Base` SKUs for any month, deterministic with a seeded PRNG (write a tiny `mulberry32(seed)`; **exact Python random values cannot be reproduced and are not required**). Rules to keep: prices = `cu / (1 − uniform(0.20,0.34))` rounded to 100; 86 % quantity 1; ~4 % cancelled orders; one extra unmatched listing (`MLA1999999999`, "Combo cable USB-C + cargador 65W", SKU `COMBO-65`) in the current month; `getGtins` returns `{_item: ean}`; `getPaymentTaxes` returns tax detail for ~90 % of payments (others `null`). The constructor takes `{ base: Base, now: Date }`. For the current month generate up to today; other months full.

## Tests (use fixtures in `tests/fixtures/demo/` created by T0; Python is the oracle)
- `readBase(demo/PnL_MercadoLibre_Septiembre2026_DEMO.xlsx)` deep-equals `base.json` and `prev_cierre.json` (floating point `toBeCloseTo`).
- `readInputs(demo/Ventas_Directas_DEMO.xlsx)` deep-equals `inputs.json`.
- Missing sheet / missing header / missing file → the expected errors.
- `DemoDataSource`: same seed → same output; every order validates against `OrderSchema`; the unmatched combo exists only in the current month; ≥1 cancelled order over a month.
- Smoke (skip with `it.skipIf(!exists)` if absent): real `data/PnL_MercadoLibre_Septiembre2026.xlsx` loads and returns > 0 SKUs. **Report in your final message how many SKUs it found and the `prev` totals** (no other data).

## Acceptance
`pnpm typecheck && pnpm lint && pnpm test` green.

## Out of scope
Calculations (T3), live API (T1), writing Excel files.
