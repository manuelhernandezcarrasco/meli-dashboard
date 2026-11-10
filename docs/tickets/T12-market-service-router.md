# T12 — Market research: service, persistence, refresh job, tRPC

**Depends on:** nothing to start (codes against contracts; at merge time needs T8, T9, T11 merged, uses their exports) · **Parallel with:** T8 T9 T10 T11 T13 · **Branch:** `t12-market-service`
**Needs DB:** yes → `./scripts/create-db.sh pnl_t12`

## Goal
Server side of the trigger/refresh rules in MARKET-CONTRACTS.md.

## Files you own
`prisma/schema.prisma` (+ migration `MarketResearch`), `src/server/market/service.ts`, `service.test.ts`, `src/server/api/routers/market.ts` (composes `marketSearchRouter` from T11), registration in `src/server/api/root.ts`.

## Spec
1. `MarketService(ownerId)` with injected deps `{ fetchPoints (T9), buildResearch (T8), store, now }` so everything is testable without ML or DB.
2. `get(catalogId)`: stored result → `ready`; running job → `running` (with previous data if any); last job failed → `failed` (+ previous data); nothing → `none`.
3. `touch(catalogId)`: if no result or `now - fetchedAt > MARKET_TTL_MS` and no job in flight → start job, return `running`. Else return current state. Single-flight per (owner, catalogId) via in-process map (same style as `rebuild`). A failed job does not overwrite stored data; a retry via `touch` is allowed after 30 s (reuse the `TOO_MANY_REQUESTS` cooldown semantics the dashboard refresh already uses).
4. `ourSellerId` comes from `MlClient.getSellerId()`; all procedures use `linkedProcedure`.
5. Jobs run only because `touch` was called. No timers, no cron, no startup hooks.
6. Add `MarketResearch` Prisma model exactly as in MARKET-CONTRACTS.md; payload is the `MarketResearch` JSON.

## Tests
`touch` with no data starts one job; 10 concurrent `touch` → 1 fetch; fresh data (<15 min) → no fetch; stale data (>15 min, fake clock) → fetch and `running` carries old data; failure keeps old data and reports `failed`; `get` never fetches; cooldown after failure.

## Acceptance
`pnpm typecheck && pnpm lint && pnpm test` green; migration applies on a clean DB.
