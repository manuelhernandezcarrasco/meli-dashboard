# T8 — Market research: stats core (pure functions)

**Depends on:** nothing (contracts in MARKET-CONTRACTS.md) · **Parallel with:** T9 T10 T11 T12 T13 · **Branch:** `t8-market-stats`

## Goal
Pure, dependency-free math that turns raw points into the cleaned set + regressions.

## Files you own
`src/lib/market.ts` (types copied verbatim from MARKET-CONTRACTS.md + `MARKET_TTL_MS`, `MARKET_MAX_SELLERS`), `src/server/market/stats.ts`, `src/server/market/stats.test.ts`.

## Spec
1. `buildResearch(input: {catalogProductId, catalogTitle, points: MarketPoint[], fetchedAt}): MarketResearch`.
2. **Cap:** if more than `MARKET_MAX_SELLERS` points, keep the top ones by `soldQuantity` (ties: lower price first); rest go to `excluded` with reason `cap`. Our own points (`isOurs`) are never dropped by cap or outlier rules.
3. **Outliers (box-plot rule):** Tukey fences (Q1−1.5·IQR, Q3+1.5·IQR) computed independently on `price` and on `soldQuantity`. Points outside → `excluded` (`price_outlier` / `sales_outlier`). Skip the rule when n < 8 (fences are meaningless). Quartiles by linear interpolation.
4. **Regression:** ordinary least squares on the kept points. `log`: ln(price) vs ln(soldQuantity), only points with sold ≥ 1 (sold = 0 can't be logged; they are still plotted, just not fitted). `linear`: price vs sold. Return `slope`, `intercept`, `r2`, `n`; `null` when n < 3 or zero variance in X.
5. Export `predictLine(reg, xMin, xMax, steps)` returning `{price, sold}[]` in original units (for the chart; log fit becomes a curve).

## Tests
Known-answer fits (perfect line → r2 = 1; hand-computed small set), power-law data recovers exponent in log mode, quartiles on odd/even n, outlier removal on a planted outlier, `isOurs` never excluded, cap ordering, n<3 → null, sold=0 excluded from log fit only, n<8 skips fences.

## Acceptance
`pnpm typecheck && pnpm lint && pnpm test` green. No imports from React, Prisma or ML code.
