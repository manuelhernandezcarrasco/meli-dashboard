# Database changelog

One entry per migration, newest first. A test fails when a folder in `prisma/migrations/` is not mentioned here, so the history cannot fall behind. For each change write: what moved, what the code must do differently, and how the rollout goes.

How to add an entry: see "Changing the schema" in [README.md](README.md).

---

## 20261112175811_competitor_sale (2026-11-12)

**Why.** The browser collector's competitor sales (PR #27) were still stored as `sold:<itemId>` JSON rows in the deprecated `ApiCache`, which the follow-up migration drops (and a docs test forbids using).

**Added.** `CompetitorSale (accountId, marketplace, itemId)`: latest `sold` reading and `nickname` per competitor listing. Existing `sold:` rows of `ApiCache` are copied by the migration.

**Code.** New `src/server/store/competitorSales.ts`; `src/server/market/sales.ts` uses it instead of `db.apiCache`.

**Rollout.** `prisma migrate deploy`; additive. Rollback = drop `CompetitorSale`.

---

## 20261112174736_stock_module (2026-11-12)

**Why.** The app becomes the source of truth for stock and weighted-average cost (plan: [../tickets/stock/PLAN.md](../tickets/stock/PLAN.md)). This migration only creates structure; no existing row changes and no data is migrated.

**Added** (13 tables): `InventoryProduct`, `StockMovement` (append-only ledger), `ProductCostEntry`, `PurchaseInvoice`, `PurchaseInvoiceLine`, `ListingLink`, `ListingLinkComponent`, `ListingSyncState`, `MlPushLog`, `StockAlert`, `ReturnCase`, `WebhookEvent`, `InventorySettings`. Enums: `MovementType`, `SyncMode`, `AlertType`, `AlertStatus`, `InvoiceStatus`, `ReturnOutcome`, `PushResult`, `LineResolution`, `CostReason`, `SyncStatus`, `PushTrigger`.

**Conventions.** Surrogate ids are `id BigInt autoincrement` inside the tenant-first primary key `(accountId, id)`, so composite foreign keys `(accountId, productId)` work. `WebhookEvent` is the one exception (plain `id`, nullable `accountId`: the tenant is unknown when a notification arrives). `ReturnCase` references `OrderItem` by its full key.

**Raw SQL in the migration** (Prisma cannot express it, `migrate diff` still reports no drift): unique index on `ListingLink (accountId, marketplace, itemId, COALESCE(variationId, 0))`; partial unique index on `StockAlert (accountId, dedupeKey) WHERE status <> 'resolved'`; `CHECK (quantity <> 0)` on `StockMovement`.

**Code.** None yet: tickets S1-S9 add the writers (see "Who writes what" in [README.md](README.md)). `ListingLink.itemId` is a soft reference to `Listing` (a link can exist before the listing is synced).

**Rollout.** `prisma migrate deploy`; additive, no downtime, rollback = drop the 13 tables and 11 enums.

---

## 20261112000000_normalize_schema (2026-11-12)

**Why.** `ApiCache` held six different kinds of data as untyped JSON keyed by string prefix, orders were one JSON row per month, and the Excel data and market research were JSON blobs. Nothing could be queried, joined or kept incrementally. Details and measurements: [ANALYSIS.md](ANALYSIS.md).

**Added** (24 live tables in total, see [SCHEMA.md](SCHEMA.md)):
`Account`, `MarketplaceConnection`, `Upload`, `Product`, `PnlClosing`, `CostOverride`, `ProductMapping`, `DirectSale`, `StockReceipt`, `Listing`, `ListingVariation`, `Seller`, `Shipment`, `Order`, `OrderItem`, `Payment`, `PaymentTax`, `OrderPayment`, `OrderPeriod`, `SaleLine`, `MarketScan`, `MarketOffer`. Enums: `Marketplace` (`mercadolibre`), `UploadKind`, `MappingKind`, `MatchVerdict`, `Channel` (`marketplace`/`direct`), `OfferExclusion`. Extension: `pg_trgm`.

**Marketplace dimension.** Everything a marketplace assigns ids to (`Listing`, `ListingVariation`, `Seller`, `Shipment`, `Order`, `OrderItem`, `Payment`, `PaymentTax`, `OrderPayment`, `OrderPeriod`, `ProductMapping`, `MatchDecision`, `MarketScan`) carries `marketplace`, as part of the primary key and the composite foreign keys, so ids from different marketplaces cannot collide. `MlConnection` became `MarketplaceConnection` keyed by `(accountId, marketplace)`. `SaleLine` has `marketplace` (null for direct sales) and `channel` is now `marketplace`/`direct`. Product master data stays marketplace-neutral (an EAN is the same product everywhere). Every `DataSource` declares its `marketplace`. Adding a marketplace = a value in the enum + a connector.

**Changed in place:**
- `Snapshot`: `ownerId` → `accountId` (FK to `Account`), `month` → `char(7)` with a format `CHECK`, `computedAt` → `timestamptz`, new index `(accountId, computedAt DESC)`.
- `MatchDecision`: `ownerId` → `accountId` (FK), `decision` text → enum `MatchVerdict`, `decidedAt` → `timestamptz`.

**Deprecated, kept for one release:** `MlToken`, `ApiCache`, `UserWorkbook`, `MarketResearch`. Dropped by the follow-up in `prisma/pending/drop_legacy_tables.sql`.

**Data.** Every legacy row is copied by the migration itself and verified inside it. Mapping and rules: [MIGRATION.md](MIGRATION.md). `SaleLine` is not backfilled: the first sync and "Recalcular histórico" fill it.

**Code.** New `src/server/store/` (bulk, idempotent, tenant-scoped reads and writes). `enrich`, `fetchMonth`, `runSync`, `rebuild`, token storage, the Excel upload store, the own-product search and the market service now use it; nothing reads the deprecated tables. Behaviour changes on purpose:
- A payment Mercado Pago has no tax detail for is asked again after 6 h (before: on every sync).
- A listing without a catalog product is asked again after 24 h (before: on every sync).
- A history rebuild reads final months from `Order` instead of downloading them again.
- `rebuildAll({ refetch })` marks everything stale instead of deleting it.
- Market research keeps history (90 days) instead of overwriting.
- Orders of the current month are stored too, and an order belongs to the month of its own instant, stored once (the old code counted month-boundary orders in two months; 7 in the real dump).
- Listings known only through search take the title of their latest sale.
- "Fetched at" stamps use the sync's clock.

**Constraints Prisma cannot show:** `Order→Shipment`, `OrderItem→Listing` and `OrderPayment→Payment` are `DEFERRABLE INITIALLY DEFERRED` so deleting an `Account` cascades; month `CHECK`s on `Snapshot`, `OrderPeriod`, `SaleLine`; `OrderItem.quantity > 0`.

**Rollout.** Backup, rehearse on a copy, deploy migration and code together, then press "Recalcular histórico". Duration 17 s for 246k legacy rows and 3.2 s on the real dump (rehearsal results in MIGRATION.md). Rollback = restore the backup. Steps in [MIGRATION.md](MIGRATION.md).

---

## 20261110132434_market_research

Added `MarketResearch` (last market scatter per catalog product, JSON). Superseded by `MarketScan`/`MarketOffer`.

## 20261104000000_match_decision

Added `MatchDecision` (person's confirm/reject of a listing ↔ EAN match, survives Excel re-uploads).

## 20261103000000_user_workbook

Added `UserWorkbook` (parsed Excel uploads as JSON). Superseded by the typed master-data tables.

## 20261102000000_per_user

Made `MlToken`, `ApiCache` and `Snapshot` per user (`ownerId` = Clerk user id). Dropped and recreated the three tables (their data was regenerable).

## 20261026191539_init

First schema: `MlToken` (singleton), `ApiCache`, `Snapshot`.
