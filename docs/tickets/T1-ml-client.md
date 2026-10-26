# T1 — Read-only Mercado Libre / Mercado Pago client + OAuth

**Depends on:** T0 merged · **Blocks:** T6, T7 · **Parallel with:** T2 T3 T4 T5
**Needs DB:** yes → `./scripts/create-db.sh pnl_t1` and set that `DATABASE_URL` in this worktree's `.env` · **Branch:** `t1-ml-client`

## Goal
Implement the live `DataSource` (CONTRACTS.md) against `api.mercadolibre.com` and `api.mercadopago.com`, plus the OAuth flow and token storage. It must be impossible for this code to write to Mercado Libre.

## Files you own
`src/server/ml/*` (replace the placeholder `index.ts`), `src/server/datasource/live.ts`, `src/app/api/auth/login/route.ts`, `src/app/api/auth/callback/route.ts`, `src/app/auth/manual/page.tsx`, tests next to each file (`*.test.ts`).

## Spec
Port from `legacy/ml_pnl_live.py`: class `ML` (lines 171–307), `taxes_from_payment` (309–325), `gtin_from_attrs` (328–336), `compact_order` (1142–1149), OAuth (`auth_interactive`, `refresh`, `ensure_token`, lines 214–252).

1. **`http.ts` — read-only guard.** One function `mlFetch(method, url, opts)` that is the *only* place doing network calls to ML/MP. Rules: allow `GET` to hosts `api.mercadolibre.com` and `api.mercadopago.com` only; allow exactly one `POST` to `https://api.mercadolibre.com/oauth/token`; **throw `ReadOnlyViolationError` for anything else** (other methods, other hosts, other POST paths). Adds `Authorization: Bearer`, `Accept: application/json`. Behaviour as Python `_req`: on 401 (first try, authenticated) refresh token once and retry; on 429/500/502/503/504 retry up to 4 times with `2**i` second backoff (make the delay injectable so tests run instantly); 404 → return `null`; other errors throw with status + first 300 chars of body; timeout 30 s.
2. **`tokens.ts`** — token store over Prisma `MlToken` (id=1): `getTokens()`, `saveTokens()`. **Refresh must be serialized**: ML refresh tokens are single-use, so keep an in-process `Promise` lock so concurrent callers share one refresh, and always persist the *new* refresh token before using the access token. `ensureToken()` refreshes when `expiresAt` is within 5 minutes.
3. **OAuth routes.**
   - `GET /api/auth/login` → 302 to `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=…&redirect_uri=…` (+ random `state` cookie).
   - `GET /api/auth/callback?code=…&state=…` → validate state, `POST /oauth/token` with `grant_type=authorization_code` (form-urlencoded), store tokens (`user_id`, `expires_in`), redirect to `/`.
   - `/auth/manual` page: text box to paste the full redirect URL (or the `TG-…` code) → server action does the same exchange. This is the fallback if ML refuses an `http://localhost` redirect URI.
   - Use env vars from `~/env` (`ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REDIRECT_URI`). Never log them.
4. **`client.ts`** — methods used by `live.ts`:
   - `ordersMonth(sellerId, y, m)` → paginates `GET /orders/search` (limit 50, `sort=date_asc`, `order.date_created.from/to` in `…T…000-03:00` format, month bounds in Argentina time).
   - `shipmentSellerCost(id)` → `GET /shipments/{id}/costs` with header `x-format-new: true`; sum `senders[].cost`; `0` if null.
   - `itemsGtin(ids)` → `GET /items?ids=…&attributes=id,attributes,variations,seller_custom_field` in chunks of 20; use `gtinFromAttrs` (attribute ids `GTIN`/`EAN`/`UPC`, first value before a comma, through `normEan`).
   - `paymentTaxes(id)` → `GET https://api.mercadopago.com/v1/payments/{id}` → `taxesFromPayment`.
   - `getSellerId()` → stored `userId` or `GET /users/me`.
5. **`taxes.ts`** — `taxesFromPayment(p)` exact port (only `type == "tax"`, only accounts.from `collector|seller`, `original − refunded`, `null` when `charges_details` is missing).
6. **`compact.ts`** — `compactOrder(raw): Order` mapping ML's raw JSON to the contract `Order` (camelCase, see CONTRACTS.md).
7. **`datasource/live.ts`** — `LiveDataSource implements DataSource`, wiring the above. Batches calls with a concurrency limit of 5 (no extra library: small helper).

## Tests (Vitest, mock `fetch`; no real network)
- Guard: `PUT/POST/DELETE/PATCH` to ML → throws; `GET` to `evil.com` → throws; the oauth token POST → allowed; a POST to `/orders/search` → throws.
- 401 → refresh once → retry succeeds; second 401 → throws. 429 then 200 → returns 200 body. 404 → `null`.
- Refresh lock: 5 parallel `ensureToken()` with an expired token → exactly 1 token POST; the new refresh token is stored.
- `ordersMonth` pagination (total 120 → 3 calls with offsets 0/50/100).
- `taxesFromPayment`: use the shape from `demo_taxes` (legacy 1583–1602): fee ignored, two taxes summed, refunded subtracted, missing `charges_details` → `null`.
- `gtinFromAttrs`, `compactOrder` (feed a raw order shaped like `demo_orders`).

## Acceptance
`pnpm typecheck && pnpm lint && pnpm test` green; a grep proves no `fetch(` to ML/MP exists outside `http.ts`: `rg "fetch\(" src/server/ml src/server/datasource` shows only `http.ts`. Do **not** call the real API in this ticket.

## Out of scope
Caching (T6), calculations (T3), UI, running real OAuth (T7).
