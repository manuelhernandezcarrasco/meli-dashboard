# PnL Diario ML — Migration to T3 (TypeScript) · Ticket index

Goal: port `legacy/ml_pnl_live.py` into a T3 app (Next.js App Router, TS, tRPC, Tailwind, Prisma + Postgres in Docker) that shows the same dashboard with real Mercado Libre data. Read-only against Mercado Libre.

## Dependency graph (what to wait for)

```
T0  (alone, first)
 ├── T1  ML + Mercado Pago live client + OAuth      ┐
 ├── T2  Workbook readers + demo data source        │  run T1–T5
 ├── T3  P&L calculation core                       │  IN PARALLEL
 ├── T4  Stock calculation                          │  after T0 is merged
 └── T5  Dashboard UI (React)                       ┘
         T6  Sync + tRPC + cache + refresh button    needs T1, T2, T3, T4 merged  (T5 soft: see T6)
         T7  Real run with Mercado Libre             needs T6 + T5 merged + the user's ML app info
```

| Ticket | Starts when | Hard-blocked by | Can run alongside |
|---|---|---|---|
| T0 | now | – | nothing (run it alone) |
| T1 | T0 merged | T0 | T2 T3 T4 T5 |
| T2 | T0 merged | T0 | T1 T3 T4 T5 |
| T3 | T0 merged | T0 | T1 T2 T4 T5 |
| T4 | T0 merged | T0 | T1 T2 T3 T5 |
| T5 | T0 merged | T0 | T1 T2 T3 T4 |
| T6 | T1+T2+T3+T4 merged | T1 T2 T3 T4 (T5 is only needed for the final visual check) | T5 if still running |
| T7 | T6 and T5 merged | T6 T5 + user input (ML redirect URI, read-only permissions) | – |

**Waiting rule:** a ticket is "done" only when its branch is merged into `main` and `pnpm typecheck && pnpm lint && pnpm test` pass on `main`. Do not launch a dependent ticket before that.

## How to run a ticket in an agent

```bash
# from the main checkout (project root), after T0 exists
git worktree add ../pnl-T1 -b t1-ml-client      # one worktree + branch per ticket
cp .env ../pnl-T1/.env                            # .env is gitignored, copy it by hand
cd ../pnl-T1 && pnpm install
```
Then give the agent: *"Read docs/tickets/README.md, docs/tickets/CONTRACTS.md and docs/tickets/T1-….md and do exactly what the ticket says."*

Tickets that need a database (T1, T6, T7) use their own database so agents do not collide:
```bash
./scripts/create-db.sh pnl_t1      # creates DB + applies migrations; then set DATABASE_URL in that worktree's .env
```
T2, T3, T4, T5 are pure code + tests: **no database, no Docker needed.**

Merge (by the user, one at a time): `git checkout main && git merge --no-ff t1-ml-client`, then run the three checks.

## Rules for EVERY agent (non-negotiable)

1. Follow the ticket literally. Do not add libraries, features, folders or refactors that are not listed. If something is missing or contradictory, stop and report it; do not guess.
2. Only touch the files your ticket owns (see "Files you own"). Shared contracts in `src/lib/contracts.ts` and interfaces in `src/server/datasource/types.ts` are owned by T0: do not edit them. If you think they are wrong, report it.
3. **Mercado Libre is read-only.** Never send POST/PUT/PATCH/DELETE to Mercado Libre or Mercado Pago, except the single `POST https://api.mercadolibre.com/oauth/token`. T1 enforces this in code.
4. Never print, log, commit or paste `ML_CLIENT_SECRET`, tokens, or the contents of `.env`. Never put secrets in tickets, tests, fixtures or docs.
5. Test-first for calculation code (T2, T3, T4): write the failing test from the fixture, then the code.
6. Port behaviour from `legacy/ml_pnl_live.py` exactly (function names and line numbers are given in each ticket). Where the Python has a quirk, keep it.
7. Dates: Argentina is a fixed UTC−3 (no DST). Use the helpers in `src/lib/dates.ts` (from T0). Dates in contracts are `"YYYY-MM-DD"` strings and times `"HH:MM"` strings.
8. Money is a JS `number`. Round to 2 decimals only where the Python does.
9. Code and identifiers in English; user-facing UI text in Spanish (Argentina), as in the template.
10. Commit on your branch with small, clear commits. Finish with: `pnpm typecheck && pnpm lint && pnpm test`, all green, then report what you did, what you did not do, and anything surprising.

## Tooling facts
Node 20.19, pnpm 9, Docker 27 + Compose v2 are installed. Python 3 is installed; legacy script needs `openpyxl` (use a venv in the agent scratch dir, never commit it).
