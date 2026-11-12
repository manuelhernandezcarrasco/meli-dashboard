# U1 — Products tab and product drawer

## Goal
`/stock/products`: see and manage every product, its stock, cost, links and ledger.

## Files you own
`src/app/stock/products/page.tsx`, `src/app/_components/stock/products/*`, tests.

## Behaviour
1. **Table** from `trpc.stockProducts.list`: name, EAN, SKU, category, on hand, in repair, unit cost (gross), coverage days + break date (with the forecast tooltip: "stock ÷ ritmo de ventas"), state chip (Sin stock / Negativo / Crítico / Bajo / OK, same colors as the old table), sync mode chip (Simulación / En vivo), linked-listings count, alert count. Filters by state/category/sync mode, search by EAN/SKU/name (debounced), sortable columns, pagination or virtualization for 1–5k rows.
2. **Drawer** per product (`get`): summary; **Listings** (linked items with ML status and last pushed/observed quantity, link/unlink, "Vincular publicación" using `previewLink` showing what data will be filled before confirm); **Movimientos** (ledger, newest first, type, signed qty, balance after, reference, reason); **Historial de costo** (entries with source: factura / excel / inicial / manual); **Ajuste de stock** form (quantity delta or target, mandatory reason); edit name/category/min units.
3. **Create product** modal (name, EAN, SKU, category, optional initial stock and cost).
4. States: loading skeletons, empty ("Todavía no hay productos: corré la migración inicial" linking to the cutover action if `cutoverAt` is null), error with retry.
5. A banner when the account is in dry-run: "Modo simulación: no se envía stock a Mercado Libre."
6. Spanish copy; numbers formatted `es-AR`; money in ARS.

## Tests
Component tests with mocked tRPC: filters, search, drawer tabs, adjust requires a reason, link preview shows fills, empty/error states.

## Done when
Checks green; screenshots (desktop + 375 px) attached; manual run against a seeded dev DB lists products and opens a drawer.
