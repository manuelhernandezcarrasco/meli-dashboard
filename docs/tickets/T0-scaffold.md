# T0 — Scaffold, Docker, contracts, fixtures

**Depends on:** nothing · **Blocks:** T1 T2 T3 T4 T5 (and everything after) · **Run:** alone, on `main`, before anything else
**Needs DB:** yes (local, to verify migrations) · **Branch:** work directly on `main`

## Goal
Turn the project folder into a working T3 app with Postgres in Docker, the shared contracts, the shared helpers and the Python-generated test fixtures, so T1–T5 can run in parallel without touching the same files.

## Preconditions (already done by the user/assistant — do not redo, do not overwrite)
`.env` (contains `ML_CLIENT_ID`, `ML_CLIENT_SECRET` — keep them, never print them) and `.gitignore` already exist in the project root.

## Steps
1. **Move legacy files** (keep content unchanged; first `chmod u+w ml_pnl_live.py`):
   - `mkdir legacy data` → `ml_pnl_live.py`, `README.md`, `config.example.json`, `config.demo.json`, `dashboard_template.html` → `legacy/`
   - `PnL_MercadoLibre_Septiembre2026.xlsx`, `Ventas_Directas_y_Mapeo.xlsx` → `data/`
   - `demo/` stays where it is (fixtures). Remove `.DS_Store`.
2. **Scaffold T3 in a temp directory, then move it in** (the root is not empty): run `pnpm create t3-app@latest` into a temp dir with: TypeScript, tRPC, Tailwind, Prisma, **no NextAuth**, App Router, Postgres, no CI, no git, no install (check `--help` for exact flags; use `--CI` to skip prompts). Copy everything into the project root **except** it must not overwrite `.env` or `.gitignore` (merge: keep ours, append anything T3 needs, e.g. `next-env.d.ts`). Then `pnpm install`.
3. **Docker.**
   - `docker-compose.yml`: service `db` = `postgres:16-alpine`, port `5432:5432`, named volume `pgdata`, env from `.env` (`POSTGRES_USER=pnl`, `POSTGRES_PASSWORD=pnl`, `POSTGRES_DB=pnl`), healthcheck `pg_isready -U pnl`. Service `app` = built from `Dockerfile`, depends on `db` healthy, `env_file: .env`, `DATABASE_URL` pointing at host `db`, port `3000:3000`, bind-mount `./data:/app/data:ro`, command runs `pnpm prisma migrate deploy` then starts the server.
   - `Dockerfile`: multi-stage (deps → build → runner), Node 20 alpine, pnpm via corepack, Next `output: "standalone"` in `next.config.js`, runs as non-root, copies `prisma/`.
   - `.dockerignore`: `node_modules .next .git .env data legacy docs`.
   - `scripts/create-db.sh <name>`: `docker compose exec -T db psql -U pnl -d pnl -c "CREATE DATABASE <name>"` (ignore "already exists"), then `DATABASE_URL=postgresql://pnl:pnl@localhost:5432/<name> pnpm prisma migrate deploy`. Make it executable.
4. **Env.** In `.env` add (do not remove the ML_* lines): `DATABASE_URL=postgresql://pnl:pnl@localhost:5432/pnl`, `POSTGRES_USER=pnl`, `POSTGRES_PASSWORD=pnl`, `POSTGRES_DB=pnl`, `ML_REDIRECT_URI=http://localhost:3000/api/auth/callback`, `DATA_SOURCE=demo`, `BASE_PNL_PATH=data/PnL_MercadoLibre_Septiembre2026.xlsx`, `VENTAS_DIRECTAS_PATH=data/Ventas_Directas_y_Mapeo.xlsx`. Create `.env.example` with the same keys and **empty/placeholder values** (no real secret). Extend `src/env.js` (T3's `@t3-oss/env-nextjs` schema) with all of them: `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REDIRECT_URI` (url), `DATA_SOURCE` (`z.enum(["demo","live"])`), `BASE_PNL_PATH`, `VENTAS_DIRECTAS_PATH` (optional).
5. **Prisma schema** (`prisma/schema.prisma`, provider postgresql) and first migration `init`:
   - `MlToken { id Int @id @default(1); accessToken String; refreshToken String; userId BigInt; expiresAt DateTime; updatedAt DateTime @updatedAt }` (singleton row id=1)
   - `ApiCache { key String @id; value Json; updatedAt DateTime @updatedAt }` (keys like `ship:<id>`, `gtin:<itemId>`, `tax:<paymentId>`, `orders:2026-09`)
   - `Snapshot { month String @id; payload Json; computedAt DateTime }`
   Remove T3's example `Post` model and its router/page.
6. **Config.** `config/business.json` with the business values from `legacy/config.example.json` (everything except `client_*`, `redirect_uri`, `*_path`, `output_dir`), camelCased, `mes: ""`. `src/server/config.ts`: Zod-validated loader returning `BusinessConfig`; env var overrides are not needed.
7. **Contracts + interfaces:** create `src/lib/contracts.ts` and `src/server/datasource/types.ts` exactly from `docs/tickets/CONTRACTS.md` (Zod schemas + `z.infer` types, exported).
8. **Helpers (test-first, Vitest):** `src/lib/normalize.ts` ports `norm_ean, norm_hdr, to_num, to_pct, norm_cat` (`legacy/ml_pnl_live.py` lines 78–135); `src/lib/dates.ts` per CONTRACTS.md (Python `days_in`, `prev_ym`, TZ −03:00; `toArgParts` converts an ISO string to Argentina date/time by subtracting 3 h from UTC). Tests: `normEan("7.50e+12")`, `normEan("123.0")`, `toNum("1.234,5") === 1234.5`, `toPct("15%") === 0.15`, `daysIn(2026,2) === 28`, `prevYm(2026,1)` → `[2025,12]`, `toArgParts("2026-10-01T02:30:00.000Z")` → `2026-09-30 23:30`.
9. **Python fixtures.** Create a venv **outside the repo** (`python3 -m venv $SCRATCH/venv && pip install openpyxl`). Write `legacy/dump_fixtures.py` that imports `ml_pnl_live`, loads `config.demo.json` (path-resolved to `demo/`), and for month `2026-10` with a **fixed cut day = 20** (no `now`-dependence) dumps JSON to `tests/fixtures/demo/`: `orders.json` / `prev_orders.json` (from `demo_orders`, seeds 42 and 7 as in `run_sync`, already compact via `compact_order`), `ship_costs.json`, `gtins.json`, `taxes.json` (from `demo_taxes`), `base.json`, `prev_cierre.json`, `inputs.json` (from `read_base` / `read_inputs`), `lines.json` (from `build_lines`, using the same "auto" tax calibration code as `run_sync`), `daily.json` (`daily_series`), `stock.json` (`compute_stock(..., corte=20, ...)`). Dates → `"YYYY-MM-DD"`. Then convert keys to the TS contract names (write the converter inside the dump script; the output files must already match `CONTRACTS.md`). Also run `run_sync(cfg, demo=True)` into a temp output dir and extract the JSON between `const DATA = ` … from the generated HTML into `tests/fixtures/demo/dashboard.python.json`; map it into the `DashboardData` shape as `src/lib/sample-dashboard.json`. Commit the fixtures (they contain only fake demo data).
10. **tRPC stubs.** In `src/server/api/routers/dashboard.ts` add `get` (query), `refresh` (mutation), `status` (query), all returning `sample-dashboard.json` (typed `DashboardData`) / `{updatedAt, nextRefreshAt, cooldownSeconds: 0}`. Register in `root.ts`. Create **empty placeholder files with a `// owner: T<n>` header** so branches do not collide: `src/server/ml/index.ts` (T1), `src/server/workbooks/index.ts` + `src/server/datasource/demo.ts` (T2), `src/server/calc/index.ts` (T3), `src/server/calc/stock.ts` (T4), `src/app/_components/dashboard/index.tsx` (T5), `src/server/sync/index.ts` (T6).
11. **Tooling:** Vitest (`pnpm test`), scripts `typecheck` (`tsc --noEmit`), `lint`, `test`. ESLint/Prettier as T3 generated.
12. `git init -b main`, first commit (check `git status` first: `.env`, `data/`, `node_modules` must NOT be staged), `git config` local only, no remote.

## Acceptance (all must pass)
- `docker compose up -d db` healthy; `./scripts/create-db.sh pnl_check` works and `\dt` shows the three tables.
- `pnpm typecheck && pnpm lint && pnpm test` green; `pnpm build` succeeds.
- `pnpm dev` → `http://localhost:3000` renders T3 placeholder page without errors; `curl` of the tRPC `dashboard.get` returns the sample.
- `docker build .` succeeds.
- `git status` clean and `git ls-files | grep -E '\.env$|data/|node_modules'` prints nothing.
- Fixtures exist and parse against the Zod schemas (add a test `fixtures.test.ts` that does this).

## Out of scope
Any real logic (ML client, calculations, UI). Do not create `NextAuth`. Do not run against real Mercado Libre.
