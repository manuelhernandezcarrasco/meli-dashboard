# U3 — Alerts tab

## Goal
`/stock/alerts`: every alert in one place, with the actions that resolve it.

## Files you own
`src/app/stock/alerts/page.tsx`, `src/app/_components/stock/alerts/*`, tests.

## Behaviour
1. List from `stockAlerts.list` grouped by type with counts, filters (status open/acknowledged/resolved, type, product), newest first, severity color. Each row: title, detail, product/listing link, age, actions **Reconocer** and **Resolver**.
2. **Resolution forms** per type (from S7's form specs):
   - `unmatched_listing` / `unmatched_sale`: choose "Vincular con producto existente" (search, preview of fields to be filled) or "Crear producto" (form prefilled from the listing: title, GTIN, SKU) or "Ignorar".
   - `link_cost_review`: show the calculated cost and the pending sales that will be applied; **Aceptar** or **Editar costo** (required before the pending sales are applied).
   - `missing_cost`: enter a unit cost.
   - `suggested_match` / `auto_match`: confirm / reject / undo (the old dashboard card behaviour).
   - `negative_stock`: text explaining it may be an unfinished migration; actions: adjust stock (reason required), acknowledge.
   - `push_failed` / `stock_drift`: show our qty vs ML qty, "Reintentar envío" and "Aceptar valor de ML" (adjust ours with a reason) — never silent.
   - `low_stock` / `out_of_stock` / `margin_drop`: link to the product drawer; acknowledge.
3. The tab shows an open-alerts badge; resolved alerts remain visible under the "Resueltas" filter.
4. States: empty ("Sin alertas"), loading, error.

## Tests
Mocked tRPC: each form's validation and submission payload, acknowledge/resolve optimistic update and rollback on error.

## Done when
Checks green; screenshots of at least three alert types with their forms.
