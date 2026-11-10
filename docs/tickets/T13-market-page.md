# T13 — Market research: page and live refresh behaviour

**Depends on:** nothing to start (mock the `market` router per contracts); final wiring check needs T10 and T12 merged · **Parallel with:** T8 T9 T10 T11 T12 · **Branch:** `t13-market-page`

## Goal
`/market-research/[catalogProductId]` implementing the client half of the refresh policy.

## Files you own
`src/app/market-research/[catalogProductId]/page.tsx`, `src/app/_components/market/MarketPage.tsx`, `useMarketResearch.ts`, tests next to them.

## Spec
1. Follow the structure of `DashboardPage` (`dashboard/index.tsx`): connection check, skeleton, link-ML screen, error banner keeping last data.
2. `useMarketResearch(catalogId)`: on mount call `market.touch` once; `market.get` with `refetchInterval: 2000` **only while** `status === "running"`, otherwise off; a `setInterval` of `MARKET_TTL_MS` that calls `touch` while the component is mounted; cleared on unmount. Nothing runs when the page isn't open.
3. Header: catalog title, "Actualizado hace X min" from `fetchedAt`, small "Actualizando…" spinner when `running` with previous data; full skeleton only when `running`/`none` with no data.
4. `failed`: error banner + last data if any + "Reintentar" button (calls `touch`).
5. Back link to dashboard. Renders `<MarketChart>` from T10.
6. Items without catalog: not reachable here (entry points handle it); if the catalog id is unknown to ML show an empty state.

## Tests (fake timers, mocked tRPC)
Mount triggers exactly one `touch`; advancing 15 min triggers another; unmount stops intervals (advance 30 min → no calls); polling `get` only while running; running+old data keeps chart visible with spinner; failed shows retry.

## Acceptance
`pnpm typecheck && pnpm lint && pnpm test` green. After T10 and T12 merge, one manual run against `DATA_SOURCE=demo` or the real account to confirm the end-to-end flow.
