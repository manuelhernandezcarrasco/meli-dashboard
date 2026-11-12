# S5 — Listing links, product matching, product CRUD

## Goal
Decide which listing/variation feeds which product(s). Auto-link only on exact EAN/GTIN; everything else is manual and enriches the product.

## Files you own
`src/server/stock/linking.ts`, `src/server/store/stockLinks.ts`, `src/server/store/inventoryProducts.ts`, `src/server/api/routers/stock-products.ts`, tests.

## Behaviour

1. **Auto-link** `autoLink(accountId)`: for every `Listing` / `ListingVariation` without a `ListingLink`, if its GTIN (variation GTIN first, then item GTIN; normalized through `normEan`) equals an `InventoryProduct.ean` → create a `ListingLink` with one component (qty 1). No title-similarity auto-links in this module (the old fuzzy matcher keeps working only for the legacy dashboard). Listings with variations link **per variation**; a listing with variations never gets a listing-level link.
2. **Unlinked listings** raise `unmatched_listing` alerts (S7 renders them) with the data needed for the form: title, itemId, variations, any GTIN/SKU seen.
3. **Manual link** `linkListing({itemId, variationId?, components:[{productId, quantity}]}, {fillMissing: true})`:
   - Creates/replaces the `ListingLink` + components in one transaction.
   - **Enrich, never overwrite**: product fields that are empty (EAN, sku, name, model, category) are filled from the listing/ML data; the function returns a `plan` of fills so the UI can preview them first (`previewLink` returns the plan without writing).
   - Raises a `link_cost_review` alert (cost shown = current weighted cost) when pending sales exist for the listing. **Pending sales are applied by S4 only after the alert is resolved** with an accepted or edited cost (editing writes via S1 `excel_reset`-style `manual` cost entry).
   - Combos: the data path accepts several components, but the router in v1 rejects `components.length > 1` with a clear message ("Combos: próximamente"). Keep validation in one place so F1 only removes it.
4. **Create product** `createProduct({name, ean?, sku?, category, initialStock?, initialCost?})`: validates EAN uniqueness; initial stock goes through S1 as `initial_count`/`manual_adjust` with a reason.
5. **Router** `stock-products.ts` (tRPC, all `linkedProcedure`): `list` (filters: status, category, search by EAN/SKU/name, `hasAlerts`; sort), `get` (product + links + last 50 movements + cost history), `create`, `update` (name/category/minUnits only), `adjustStock` (reason required, via S1), `previewLink`, `link`, `unlink`, `autoLink`, `unlinkedListings`. Row shape = `ProductRow` from S0 contracts, including `coverageDays`, `breakDate` (computed by S7's forecast function; call through the contract interface, fake until merged), `onHand`, `inRepair`, `unitCost`, `syncMode`, `linkedListings`.

## Tests
Exact GTIN auto-link; variation-level linking; no auto-link on mismatch; enrich fills empty fields only and preview equals the applied result; duplicate EAN rejected; unlink; list filters; combo rejected at router level but works at service level.

## Done when
Tests green; no write to `ListingLink`/`ListingLinkComponent`/`InventoryProduct` identity fields outside the store files above.
