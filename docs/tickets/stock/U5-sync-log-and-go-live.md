# U5 — Sync log tab and go-live flow

## Goal
`/stock/sync`: see what we would push or did push to Mercado Libre, and switch products from simulation to live safely.

## Files you own
`src/app/stock/sync/page.tsx`, `src/app/_components/stock/sync/*`, tests.

## Behaviour
1. **Status header**: mode summary (N productos en simulación, M en vivo), last reconcile time, last webhook received, open drift/failed counts.
2. **Push log** table from `stockSync` (S3): time, listing, variation, requested qty, previous ML qty, mode (Simulación / En vivo), result (ok / failed / skipped / simulated), trigger (venta, factura, ajuste, conciliación, manual), error text. Filters by result, mode, listing.
3. **Go-live wizard** (per product or "todos los listos"): step 1 shows for each linked listing **ML's current available quantity next to ours**; step 2 asks the person to confirm our opening stock or edit it (reason required, written via the adjust path); step 3 explains what will happen ("se enviará stock a N publicaciones") and requires an explicit confirm. Products with negative stock, drift or unresolved alerts are listed as blocked with the reason. A "Volver a simulación" action per product.
4. **Dry-run preview**: for the current state, a table "lo que se enviaría ahora" (simulated pushes) so the person can compare with ML before going live.
5. Spanish copy; destructive/outward actions always behind a confirmation dialog.

## Tests
Mocked tRPC: wizard blocks negative/drift products, requires confirmation, edited stock payload includes a reason; log filters.

## Done when
Checks green; screenshots of log, wizard step 1 and the final confirm.
