# X1 — End-to-end verification report

Automated server-level run of the whole stock loop in dry-run, on a throwaway Postgres database, with Mercado Libre mocked at `fetch` (the real ML is never contacted). Code: `src/server/stock/e2e.test.ts` (29 tests).

Run it alone:

```bash
./scripts/create-db.sh pnl_x1
TEST_DATABASE_URL=postgresql://pnl:pnl@localhost:5432/pnl_x1 pnpm vitest run src/server/stock/e2e.test.ts
```

## How it was tested (and why failures are meaningful)

- Real tRPC routers (`stock-cutover`, `stock-products`, `stock-invoices`, `stock-alerts`, `stock-returns`, `stock-sync`), real route handlers (`/api/webhooks/ml`, `/api/cron/stock-reconcile`, `/api/invoices/upload`), real `saveUpload` for the demo workbook, real Sony sample PDF.
- **Production wiring only**: the test never calls `configureStock`, `configureReturnsService`, `configureInvoiceService` nor injects fakes. If a scenario only works with injected fakes it is reported as a product gap, not hidden.
- Mocked: `fetch` (a fake ML serving `/items`, `/orders/{id}`, `/orders/search`, `/shipments/{id}` and recording every request, including the `PUT`), Clerk `auth`, the token helpers, `next/server.after`. Every scenario asserts that the only non-GET request ever sent is the one allowed quantity `PUT`.
- Failing scenarios are `it.fails(...)` with a `KNOWN GAP (X1-Gn)` comment. When the gap is fixed the test starts "unexpectedly passing" and fails loudly: remove `.fails` then.

Status when written (main at `530f980`, before G1/G2): **22 pass, 7 expected-fail (gaps)**.

## Results per scenario

| # | Scenario | Result |
|---|---|---|
| 1 | Cutover from demo P&L → products, `initial_count`, `initial` cost entries, GTIN auto-link, idempotent, second date refused, ledger == cache | **PASS** |
| 1b | `unmatched_listing` alert for the listing that could not be linked | **FAIL — X1-G1** |
| 2 | Sony invoice: factor 1,27001, line 1 landed 69.971,74, duplicate → 409 with link, unresolved blocks confirm, manual match + skip + confirm, projected == applied, double confirm = one application, cost entry, dry-run push log row only for the affected linked listing, zero ML writes | **PASS** |
| 3 | Webhook sale: one `sale`, cost frozen (stays after a later cost change), same event twice and new event id for same order = still one, unknown user / other topic / pre-cutover order ignored, cron reconcile catches a missed webhook, bad `CRON_SECRET` → 401 | **PASS** |
| 4a | Unlinked order → `unmatched_sale` alert, no movement | **PASS** |
| 4b | Link from the Alerts tab → `link_cost_review` alert → accept → pending sales applied | **FAIL — X1-G2, X1-G6** |
| 5a | Cancel unshipped → stock restored once (repeat webhook does not restore twice) | **PASS** |
| 5b | Cancel shipped/delivered → `ReturnCase` pending, stock untouched, one case per line | **PASS** |
| 5c | Resolve the return from the Returns tab (in repair → restock, confirm required, terminal state final) | **FAIL — X1-G3** |
| 6a | Oversell → stock −2, ML payload clamped to 0 in the dry-run log, no ML write | **PASS** |
| 6b | Evaluator raises `negative_stock` / `out_of_stock`, idempotent | **PASS** |
| 6c | A sale that goes negative raises `negative_stock` on its own | **FAIL — X1-G4** |
| 7 | New P&L Excel: `excel_reset` movement with the log text, `excel` cost entry, old sale keeps its COGS, repeated cost lookup identical, ledger == cache; inputs upload after cutover returns the "Ingresos Stock se ignora" notice | **PASS** |
| 8a | Go-live: preview shows ML qty vs ours, empty confirmation refused, confirming with unchanged stock → exactly one `PUT /items/MLA1 {available_quantity}`; other product untouched; later sale → one PUT with the new qty; back to dry-run → no PUT | **PASS** |
| 8b | Go-live with an **edited** opening stock (manual_adjust + push) | **FAIL — X1-G5** |
| 9 | Alert counts feed the badge, badge links to `/stock/alerts`, dashboard has no stock table / alerts card, sidebar `useState(false)` | **PASS** (static/server checks only; see visual checklist) |
| – | Manual adjust from the Products tab | **FAIL — X1-G5** |
| – | Tenant isolation across the loop; ledger == cache after a mixed session; ML only ever got GETs (outside the go-live PUT) | **PASS** |

## Failures (product bugs — not fixed here)

Suspected locations are on `main` at `530f980`; G1/G2 may already address some.

### X1-G1 — Alerts never raised from linking (unwired stand-in)
- Repro: upload demo P&L with a listing without GTIN, run cutover, list `alert` rows of type `unmatched_listing` → none. Test: *"raises an unmatched_listing alert…"*.
- Suspect: `src/server/stock/linking.ts:53-61` — `defaultDeps.alerts.raiseAlert` just warns and returns `{alertId: 0}`; nothing calls `configureStock`. (`syncDataQualityAlerts` in `alerts.ts:200` exists but is not triggered after cutover.)

### X1-G2 — No `link_cost_review` alert after linking an unmatched listing
- Repro: webhook for an order of unlinked `MLA3` → `unmatched_sale` ✔. `stockProducts.link` for MLA3 → no `link_cost_review` alert, so the owner is never asked to confirm cost. Test: *"linking from the Alerts tab raises the cost review alert…"*.
- Suspect: `linking.ts:61` `pendingSales: async () => 0` (should be `pendingSalesCount` from `sales.ts:279`); and alerts default (G1).

### X1-G3 — Returns tab cannot resolve anything
- Repro: shipped order cancelled → pending case ✔ (`sales.ts` builds its own service). Then `stockReturns.resolve` / `create` → `Returns service is not configured…`.
- Suspect: `src/server/stock/returns.ts:164-178` (`getReturnsService` throws; nobody calls `configureReturnsService`). `sales.ts:90-96` builds a second, separate service with `evaluateProducts: async () => undefined`, so alerts are not evaluated after a return either.

### X1-G4 — Nobody evaluates alerts after a sale
- Repro: oversell a product via webhook → `onHand` −2 but no `negative_stock`/`out_of_stock` alert until `evaluateAlerts` is called manually (works when called, scenario 6b).
- Suspect: `src/server/stock/sales.ts:~165-190` (after `requestPush` there is no `evaluateAlerts`); the reconcile (`sales.ts:~246`) also never calls it despite S7 saying "by the reconcile".

### X1-G5 — Ledger stand-ins: manual adjust and edited go-live stock throw
- Repro: `stockProducts.adjustStock` → throws `LedgerService (S1) is not wired yet`; `stockSync.goLive` with `openingStock` ≠ ours → `INVALID_QUANTITY: El libro de stock (S1) todavía no está integrado`.
- Suspect: `src/server/stock/linking.ts:65` (`ledger: unwired(...)`), `src/server/stock/push.ts:55-57,69` (`localAppendMovement`; also `localRaiseAlert`/`localResolveAlert` at 48-52, so `push_failed` and `stock_drift` alerts are dropped — not covered by a scenario). `createProductWithStock` with initial stock goes through the same ledger.

### X1-G6 — Resolving a cost review alert does not apply the pending sales
- Repro: (independent of G2) create the link and a `link_cost_review` alert row by hand, `stockAlerts.resolve({id})` → no `sale` movement. Test: *"resolve(link_cost_review)… applies the pending sale"*.
- Suspect: nobody calls `applyPendingForListing` (`sales.ts:211`); `src/server/api/routers/stock-alerts.ts` `resolve` and `alerts.ts:23` `resolveAlertById` only mark the row. S4/S5 tickets assume the call happens on resolve.

## Observations (not failures)

- The Sony sample EANs are not in the demo workbook, so every invoice line starts `unresolved`: the manual-match path is the normal path with the demo data. Matching line 1 fills the empty `sku` of the product from the supplier code (only empty fields, never EAN/name) — expected per spec.
- Cutover on the demo creates at least one product with negative stock (a negative `Stock final` in the workbook), so `negative_stock` already shows after cutover.
- "Recalcular histórico" (`rebuildAll`) itself was **not** executed: it needs the full ML datasource (orders, shipments, taxes). Its stability is verified at the level it depends on: repeated `loadLedgerCosts` + `costAt` at the sale instant is identical before/after an Excel reset, and the sale movement keeps `unitCostAfter` (S6 also has `buildLines` rebuild tests).
- Scenario 9 UI parts (badge position, sidebar look, market-research index results) are not automatable here (Clerk blocks screenshots); see checklist.
- Cutover has no UI button yet (G1 in progress at the time of writing).

## Manual steps the owner still has to do

1. **ML app permission**: in the Mercado Libre developers panel give the app **read & write** on *Items / publicaciones* (today it is read-only), then reconnect the account (`/auth/login`) so the new token carries the scope.
2. **Webhook URL**: in the ML app, register the notification URL `https://<deployed-host>/api/webhooks/ml` for the topic **`orders_v2`** (same app, same user). The route is public (middleware) and always answers 200.
3. **Render cron job**: create/enable the `stock-reconcile` cron from `render.yaml` and set `CRON_SECRET` (same value in the web service and the cron job) and `APP_URL`. Check that `curl -H "Authorization: Bearer $CRON_SECRET" $APP_URL/api/cron/stock-reconcile` returns `{ok:true}` and a wrong secret returns 401.
4. **Run the cutover** once (Stock → button, after G1) with the right date; confirm counts of products created and listings linked/unlinked.
5. **Link the leftover listings** (Alerts tab) and review any `link_cost_review` alert before pending sales are applied.
6. **Switch the first product live**: Sync tab → go-live wizard on **one** product; compare ML's quantity with ours, confirm or edit the opening stock, confirm. Then check the sync log shows a single `ok` push and ML shows that quantity. Only then widen to more products; "back to dry-run" is always available.
7. Do not enable anything live until X1-G1…G6 above are fixed (G5 blocks editing the opening stock; G2/G6 block the unlinked-sale flow; G3 blocks returns).

## Visual-check checklist (owner, signed in)

- [ ] Dashboard: no stock table, no alerts card; a compact "N alertas" badge; clicking it opens `/stock/alerts`.
- [ ] Sidebar is collapsed on first load, the hamburger opens it; links: Dashboard, Stock, Market research; the active page is highlighted.
- [ ] `/stock` tabs: Productos, Facturas, Alertas, Devoluciones, Sincronización; same look (tokens, spacing) as the dashboard.
- [ ] Productos: table filters/sort work; drawer shows movements, cost history, linked listings; low/negative stock rows are marked.
- [ ] Facturas: upload the Sony PDF → review shows factor 1,2700 and the sentence "impuestos y percepciones: +27,00 %, no se descuenta IVA"; line 1 landed cost 69.971,74; "Confirmar" is disabled while lines are unresolved; after confirm the product's stock and cost changed.
- [ ] Alertas: each type renders with its form; acknowledge / resolve work; badge count updates.
- [ ] Devoluciones: shipped cancellation shows as **Pendiente**; resolve to "En reparación" then "Reingresar" (asks confirmation).
- [ ] Sincronización: log rows show *dry-run*; go-live wizard shows ML qty vs ours and needs an explicit confirm.
- [ ] Market research: the search page finds your products and opens the detail page.
- [ ] Mobile width (375 px): sidebar, tabs and tables still usable.
