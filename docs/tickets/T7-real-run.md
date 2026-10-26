# T7 — Real run against Mercado Libre (read-only) and verification

**Depends on:** T6 + T5 merged **and** the user's ML app info below · **Blocks:** nothing (MVP done)
**Needs DB:** yes → main database `pnl` · **Branch:** `main` (or `t7-real-run` for fixes)

## User prerequisites (the user must do these; the agent cannot)
1. Open https://developers.mercadolibre.com.ar → *Mis aplicaciones* → the app with client id in `.env`.
2. **Redirect URI:** register `http://localhost:3000/api/auth/callback`. If ML rejects `http`, use any `https://` URL you control (e.g. `https://www.google.com`) and set `ML_REDIRECT_URI` to it; the agent will then use the `/auth/manual` page (paste the `?code=TG-…` URL).
3. **Permissions:** confirm the app only has **read** scopes (orders/shipments read, `offline_access`). No write permission must be granted.
4. Log in with the seller account that owns the sales (MCG).

## Steps
1. `docker compose up -d db`, `pnpm prisma migrate deploy`, set `DATA_SOURCE=live` in `.env`, `pnpm dev`.
2. User opens `http://localhost:3000/api/auth/login`, approves. Verify a row exists in `MlToken` (do not print tokens).
3. Click "Actualizar ahora". Watch the server log. Expect: orders downloaded for October 2026 and September (for comparison), shipment/tax queries, the **control line**, and the tax-detail coverage line.
4. **Verify (report numbers to the user, don't fix silently):**
   - Control line difference |API+MP vs closing P&L Costo ML| — acceptable ≤ ~3 %; if larger, report which component (cargo/envío/impuestos) looks off.
   - October totals on the dashboard vs ML's own sales panel (Venta ML for the month, orders count) — user eyeballs.
   - `unmatched` list (publicaciones sin EAN) and the `assumed` share of COGS: list the top 10 so the user can fill `Mapeo ML` in `data/Ventas_Directas_y_Mapeo.xlsx`.
   - Confirm in the log that **no request other than GET (and the oauth token POST)** was sent (the T1 guard would have thrown).
5. Fix only genuine bugs found here (with a failing test first). Record any parity gap in `docs/tickets/T7-findings.md`.
6. Check `docker compose up --build` also works with `DATA_SOURCE=live` (tokens persist in Postgres across restarts).

## Acceptance (MVP done)
- Real October 2026 data renders in the dashboard, the refresh button works, the control line is within tolerance or explained, no secrets in git (`git grep -n "$ML_CLIENT_SECRET" $(git rev-list --all)` finds nothing), the secret is only in `.env`.
- After this passes, tell the user to **regenerate the client secret** in the ML panel (it was pasted in chat) and update `.env`.

## Out of scope
Hosting, dashboard auth, daily scheduled pulls, Excel and closing report (phase 2).
