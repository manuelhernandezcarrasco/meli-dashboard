# T10 — Market research: scatter chart component

**Depends on:** nothing (contracts in MARKET-CONTRACTS.md; needs `MarketResearch` type — if T8 isn't merged, copy the types into `src/lib/market.ts` identically and let the merge dedupe) · **Parallel with:** T8 T9 T11 T12 T13 · **Branch:** `t10-market-chart`

## Goal
`<MarketChart data={MarketResearch} />`, presentational only (no tRPC).

## Files you own
`src/app/_components/market/MarketChart.tsx`, `MarketTooltip.tsx`, `fixtures.ts` (a realistic fixture, ~60 points incl. 2 ours and a few excluded), `MarketChart.test.tsx`.

## Spec
1. recharts `ScatterChart`: X = price (ARS), Y = sold quantity. Two `Scatter` series: others (neutral colour) and ours (strong accent colour, larger dot). Use the existing design tokens/`Card` from `dashboard/ui.tsx`; Spanish UI copy like the rest of the app.
2. Toggle "Escala log / lineal" (default log). Log mode uses log axes and the `log` regression; linear mode the `linear` one. Hide the toggle option whose regression is `null`.
3. Best-fit line through the cloud via `predictLine` from T8 (import path `~/server/market/stats` must stay pure/client-safe; if T8 isn't merged, stub the import behind the fixture and swap on merge). Show `R²` and `n` next to the toggle.
4. Hover tooltip: seller nickname (bold), title, price (ARS format used elsewhere), sold count (prefix "+" or "≈" when `!soldExact`).
5. Click a dot → `window.open(permalink, "_blank", "noopener,noreferrer")`; cursor pointer on dots.
6. Below the chart: collapsed "Excluidos (N)" list with reason, using the collapsible pattern already used for alerts.
7. Empty state when `points.length === 0`.

## Tests
Renders both series, ours coloured differently, toggle switches regression line, tooltip content for exact/approx, click calls `window.open` with the permalink, empty state, excluded list.

## Acceptance
`pnpm typecheck && pnpm lint && pnpm test` green; screenshot of the fixture in light mode attached to the PR.
