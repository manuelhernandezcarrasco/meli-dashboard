# T6 — Sync orchestration, cache, tRPC, refresh button

**Depends on:** T1 + T2 + T3 + T4 merged (T5 only for the final visual check) · **Blocks:** T7
**Needs DB:** yes → `./scripts/create-db.sh pnl_t6` · **Branch:** `t6-sync`

## Goal
Replace T0's stubbed `dashboard` router with the real thing: fetch → enrich (cached) → compute → store snapshot → serve, with stale-while-revalidate (15 min TTL) and a forced refresh with 60 s cooldown. Works in `DATA_SOURCE=demo` today and `live` in T7.

## Files you own
`src/server/sync/*` (replace placeholder), `src/server/api/routers/dashboard.ts`, `src/server/datasource/index.ts` (factory), tests, `docker-compose.yml` (only if the app container needs fixes).

## Spec
1. **`datasource/index.ts`** — `getDataSource()` returns `DemoDataSource` (needs `Base` from `readBase`) or `LiveDataSource` depending on `env.DATA_SOURCE`.
2. **`sync/enrich.ts`** — port of `enrich` (1167–1212) using `ApiCache` (Prisma): shipment costs cached per id (re-fetch when the order is < 3 days old), GTINs cached per item id, payment taxes cached per payment id (re-fetch when `null` or the order is < 2 days old); stop querying taxes after 5 failures in one run (log a warning, keep `null`). Previous-month orders cached under `orders:YYYY-MM` and re-downloaded only during days 1–5 of the next month (`fetch_month`, 1152–1164; current month never cached).
3. **`sync/run.ts`** — `runSync(now = new Date())`: month from `cfg.mes` or current Argentina month; `readBase`/`readInputs` from env paths; fetch current + previous month; enrich; `calibrateTaxPct`; `computeDashboard` (inject `computeStock`); cut day = today's day if current month (else last day with sales / month length), exactly as `run_sync` 1301–1316; save `Snapshot(month, payload, computedAt)`; log the **control line** like the Python (`Control <prev month>: Costo ML según API+MP X vs P&L cierre Y (±z%)`) and the "N/M líneas con detalle real de Mercado Pago" line. Never log order contents or secrets.
4. **`sync/service.ts`** — `getDashboard()`: returns the latest `Snapshot`; if missing → run a sync and wait; if older than `refreshMinutes` → return the stale snapshot immediately and start **one** background sync (in-process in-flight promise so concurrent requests share it). `forceRefresh()`: if the last forced/any sync started < 60 s ago throw `TRPCError({code:"TOO_MANY_REQUESTS", message: "Espere N s"})`, else run sync and return the new data. `status()` → `{ updatedAt, nextRefreshAt, cooldownSeconds, source: env.DATA_SOURCE, syncing: boolean, lastError?: string }`.
5. **tRPC `dashboard` router**: `get` (query, returns `DashboardData`), `refresh` (mutation), `status` (query). All `publicProcedure` (single-user localhost MVP). If a sync fails and a snapshot exists, serve the snapshot and expose the error in `status.lastError`; if none exists, throw.
6. Docker: `docker compose up --build` starts `db` + `app`, migrations apply, the dashboard loads with demo data at `http://localhost:3000`.

## Tests
- `runSync` with `DemoDataSource` + the real demo workbooks (`demo/`) produces a payload that validates against `DashboardDataSchema` and is stored in `Snapshot`.
- Enrich caching: a second run makes zero shipment/GTIN/tax calls for old orders (spy on the data source).
- Service: fresh snapshot → no sync; stale → returns stale immediately, exactly one background sync even with 10 concurrent `get`s; `forceRefresh` twice within 60 s → second throws `TOO_MANY_REQUESTS` (inject a clock).
- Use the `pnl_t6` database for DB tests; clean tables between tests.

## Acceptance
`pnpm typecheck && pnpm lint && pnpm test && pnpm build` green; `docker compose up --build` works end to end in `demo` mode; with T5 merged, open the page, click "Actualizar ahora" (works), click again (shows the cooldown message).

## Out of scope
Real Mercado Libre run (T7), auth for the dashboard, Excel/closing report, scheduled jobs.
