# U6 — Market research index page

## Goal
`/market-research`: a search page so the sidebar link has somewhere to go. Search the user's products, click one, land on the existing detail page.

## Files you own
`src/app/market-research/page.tsx`, `src/app/_components/market-research/Index*.tsx` (new files only; do not edit the existing detail page or its components), tests.

## Behaviour
1. Reuse the existing own-product search used by the dashboard's market links (see `docs/tickets/T11-market-search-and-links.md` and `src/server/market/*`, `Listing.searchText`): a search bar with the same behaviour as today, results list with title, EAN, catalog product id, last scan time if available.
2. Clicking a result navigates to `/market-research/[catalogProductId]`. Results without a catalog product show why (no catalog id) and are not clickable.
3. Without a query show the products that already have a `MarketScan`, most recent first.
4. Empty, loading and error states; Spanish copy; matches the existing page styling. Add a tRPC query only inside the existing `market` router **file you are allowed to extend**: `src/server/api/routers/market-search.ts` (add one procedure, e.g. `recent`), nothing else there.

## Tests
Component test with mocked tRPC (search, result click target, empty state).

## Done when
Checks green; screenshots attached.
