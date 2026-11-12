# Stock module — plan

Source of truth for stock and cost becomes **this app**, not Mercado Libre (ML) and not the Excel. ML receives our available quantity. Designed from a grilling session; every decision below was confirmed by the owner.

## 1. Decisions (confirmed)

| Area | Decision |
|---|---|
| Location | One stock number per product (self-fulfilled). ML Full is out of scope. |
| Product ↔ listing | A listing (or a variation) links to a **list of components** `(product, quantity)`. Simple listing = 1 component × 1. Available qty = `min over components floor(onHand / qty)`. v1 UI links simple listings only; combo-builder UI is ticket F1. Data model and stock math support combos now. |
| Variations | Linked per variation when the listing has variations (each variation → its own product), otherwise per listing. |
| Stock changes | Only through **events** in an append-only ledger (`StockMovement`). `onHand` is a cache derived from it. Never edited directly. Logs live in Neon Postgres (no external logging service). |
| Cost | Moving **weighted average**. Sales freeze the cost in effect at sale time (history never changes). |
| Invoice landed cost | `feeFactor = invoice.total / invoice.subtotal`, one per invoice, applied to every line. Cost is gross: IVA, perceptions and other taxes are **not** netted out. Editable and visible in the review screen before confirm. |
| Invoice flow | Upload → parse → **review screen** (nothing is written until Confirm). Lines match by EAN/GTIN exactly; others get manual match (to an existing product) or "create product". Manual match fills only missing product fields, never overwrites; the preview lists exactly what will be filled. |
| Excel upload after cutover | Acts like an event: sets **cost and stock** from that moment forward (stock correction movement + cost-reset entry), logged as such. Past sales keep their frozen cost. |
| Cutover | One-time import of the latest P&L workbook creates `initial_count` movements and the starting cost per EAN. Products are created from it. After the cutover date the ledger drives stock/cost; the Excel drives only pre-cutover history. |
| Linking | Auto-link only on exact EAN/GTIN. Everything else → alert with manual match or data-entry form. |
| Sales | ML `orders_v2` webhook (fast path, idempotent per order line) + scheduled reconcile (safety net). Only `paid` orders count (as today). Stock decrements while the dashboard is closed. |
| Unlinked sales | Parked + alert. When the user links the listing, an alert asks to confirm/edit the calculated cost, then pending sales are applied retroactively from the cutover date. |
| Cancel / return | Cancellation before shipping restores stock automatically. Returns go to a **Returns page**: pending → *lost* (no restock, logged), *in repair* (separate bucket, not sellable; later restock or lost), *restocked* (manual confirm). Never automatic restock for returns. |
| Negative stock | Allowed internally; raises an alert. ML only ever receives `max(0, qty)`. |
| Push to ML | Automatic, with retries and per-listing sync status. Only listings explicitly linked are touched; unknown products are never pushed as 0. **Dry-run is the default**: pushes are logged, not sent, until a product (or all) is switched live. Switching a product live shows ML's current `available_quantity` vs ours and requires confirm/edit of our opening stock. Drift/negative never auto-pushes: alert and wait. |
| ML write | Guard in `mlFetch` opens for exactly one call: set `available_quantity` on an item/variation. Owner updates ML app permissions to read/write. |
| Alerts | Moved from the dashboard to the stock page. Types: low stock (days of coverage, optional per-product min units), out of stock with active listings, negative stock, push failure / drift, margin dropped after a cost change, plus the four existing data-quality alerts (suggested matches, auto-matches, missing costs, unmatched listings). Ack + resolve on each. Coverage = onHand / recent sales rate (a forecast). |
| Dashboard | Stock table and alerts card removed; only a compact "N alertas" badge linking to `/stock`. |
| Navigation | Collapsible sidebar, collapsed by default, hamburger (3 lines) icon, links: Dashboard, Stock, Market research (a search page of products → market-research detail). New pages match the existing UI. |

## 2. Architecture fit with the normalized schema

Follow `docs/database/README.md` exactly: tenant-first PKs `(accountId, …)`, composite FKs, `Decimal(16,4)` money, `Decimal(14,3)` quantities, `timestamptz`, `///` comments on every model/column, migration + `CHANGELOG.md` entry + `pnpm db:docs`, and **all DB access in `src/server/store/`** with round-trip tests in `store.test.ts`. Marketplace data is keyed with `marketplace`; the stock module is marketplace-neutral (a second marketplace = enum value + connector).

The existing `Product` table is the *P&L close snapshot* (replaced wholesale by each pnl upload, `ean` is its key). It cannot be the permanent master. The module adds **`InventoryProduct`** (surrogate id, nullable unique `ean`) and leaves `Product`/`SaleLine` semantics intact for pre-cutover history. Cutover seeds `InventoryProduct` from `Product`.

New tables (S0 owns all of them): `InventoryProduct`, `StockMovement`, `ProductCostEntry`, `PurchaseInvoice`, `PurchaseInvoiceLine`, `ListingLink`, `ListingLinkComponent`, `ListingSyncState`, `MlPushLog`, `StockAlert`, `ReturnCase`, `WebhookEvent`, `InventorySettings`. Detail in S0.

Code layout: domain in `src/server/stock/*`, DB in `src/server/store/stock*.ts`, ML write in `src/server/ml/stock-write.ts`, routers `src/server/api/routers/stock-*.ts`, UI in `src/app/stock/*` and `src/app/_components/stock/*`.

## 3. Execution order (parallel waves)

```
Wave 0  S0 schema+contracts+stubs (alone)
Wave 1  S1 ledger/costing · S2 invoice parser · S3 ML stock write+push · S5 linking · S7 alerts · S8 returns · U0 shell+dashboard cleanup · U6 market index
Wave 2  S4 sales ingestion · S6 cutover+Excel events · S9 invoice service  ·  U1 products · U2 invoices · U3 alerts · U4 returns · U5 sync log+go-live
Wave 3  X1 end-to-end check · F1 combo UI (future)
```
A ticket is done only when merged to `main` with `pnpm typecheck && pnpm lint && pnpm test` green. Run each in its own worktree as described in `docs/tickets/README.md`; database tickets get their own DB (`./scripts/create-db.sh pnl_<ticket>`).

## 4. Open items / risks

- **Invoice PDF text**: parser assumes a text-layer PDF (the Sony sample). S2 must verify; scanned PDFs are out of scope.
- **ML permissions and webhooks**: owner must enable write scope and register the notification URL (`orders_v2`) in the ML app; needs the deployed public URL.
- **Scheduled reconcile**: needs a Render cron job (or external pinger) calling a secret-protected route. Defined in S4.
- **Overselling window**: ML decrements its own quantity on sale and we push right after; brief mismatch is expected and reconciled.
- **Legacy dashboard COGS**: after cutover, `SaleLine.unitCost` for new sales comes from the cost history (S6); before cutover it is unchanged.
