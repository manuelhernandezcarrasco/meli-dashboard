# T11 — Market research: entry points (stock links + search box)

**Depends on:** nothing (contracts in MARKET-CONTRACTS.md; the page route is just a URL) · **Parallel with:** T8 T9 T10 T12 T13 · **Branch:** `t11-market-entry`

## Goal
Get the user from the dashboard to `/market-research/[catalogProductId]`.

## Files you own
`src/server/api/routers/market-search.ts` (merged into the `market` router by T12 — export a sub-router `marketSearchRouter` with the two procedures below), `src/server/market/ownProducts.ts` (+ tests), `src/app/_components/dashboard/MarketSearchBox.tsx`, edits to the critical-stock table in `tables.tsx` / `Dashboard.tsx`.

## Spec
1. `searchOwnProducts({query})` — from the latest `Snapshot` payload, collect our distinct products (itemId, title), normalise (lowercase, strip accents) and substring-match; max 10; each result carries `catalogProductId` or `null`. To get catalog ids use `getCatalogProductId` from T9 behind an interface (`CatalogIdLookup`), cached in `ApiCache` as `catalog:<itemId>`; until T9 merges, inject a fake in tests.
2. `catalogIdForItem({itemId})` — same lookup for a single item (used by stock rows).
3. `MarketSearchBox`: text input with debounced (250 ms) dropdown inside the critical-stock card. Selecting a result with a catalog id navigates to `/market-research/<id>`; one without shows a disabled row "Sin catálogo — no soportado todavía".
4. Each row in the critical-stock table gets a link/button "Investigar mercado": resolves the catalog id on click (`catalogIdForItem`), navigates, or shows an inline "Sin catálogo" notice.

## Tests
Accent/case-insensitive match, 10-result cap, null catalog handling, lookup cached, component: typing → dropdown → navigation (mock `useRouter`).

## Acceptance
`pnpm typecheck && pnpm lint && pnpm test` green.
