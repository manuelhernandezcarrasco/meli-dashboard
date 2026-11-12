# Migration `20261112000000_normalize_schema`

Moves the data from the four JSON-store tables into the typed schema of [SCHEMA.md](SCHEMA.md). Why: [ANALYSIS.md](ANALYSIS.md).

It is the **expand** half of an expand/contract migration. The legacy tables stay in place, untouched, until a second migration (the **contract** half, below) drops them once the result is verified.

## Where each legacy row goes

Every migrated marketplace row is tagged `marketplace = 'mercadolibre'` (the only marketplace that existed); it is part of the primary key of listings, orders, items, payments, taxes, shipments, sellers, mappings, decisions and connections, and of the foreign keys between them. An order is stored once and belongs to the month of its own instant (see ANALYSIS.md C5).

| Legacy | Becomes | Rule |
|---|---|---|
| every distinct `ownerId` | `Account` | `createdAt` = earliest timestamp found for that owner |
| `MlToken` | `MarketplaceConnection` | `marketplace` = `mercadolibre`; `userId` → `externalUserId` (text, so other marketplaces can use non-numeric ids); `updatedAt` also seeds `linkedAt` |
| `UserWorkbook` (`kind`, `fileName`, `uploadedAt`) | `Upload` | `rowCount` computed once (products, or direct-sale rows) |
| `UserWorkbook.payload.base` (pnl) | `Product` | key = EAN; `position` = the order the app has always iterated them in (JSONB key order) |
| `UserWorkbook.payload.prev` (pnl) | `PnlClosing` | one row |
| `UserWorkbook.payload.override` (inputs) | `CostOverride` | |
| `…payload.mapItem` / `mapSku` (inputs) | `ProductMapping` | `kind` = `item` / `sku` |
| `…payload.va` (inputs) | `DirectSale` | file order kept (`id` ascending) |
| `…payload.ingresos` (inputs) | `StockReceipt` | |
| `ApiCache` `orders:YYYY-MM` | `OrderPeriod` + `Order` + `OrderItem` + `OrderPayment` | `final` → `isFinal`; if two month blobs hold the same order the most recently written wins; item ids upper-cased |
| `ApiCache` `ship3:<id>` | `Shipment.sellerCost` + `costFetchedAt` | a `Shipment` row also exists for every shipment an order references (cost not asked yet) |
| `ApiCache` `ship:<id>`, `ship2:<id>` | **not migrated** | superseded v1/v2 keys, no code reads them (a third of the real cache) |
| `ApiCache` `tax:<id>` | `Payment.taxTotal/financingFee/taxFetchedAt` + `PaymentTax` | JSON `null` → asked, no detail (`taxFetchedAt` set, `taxTotal` null); entries without `financing` keep their total and get `financingFee` null, so the next sync asks again once (as before) |
| `ApiCache` `gtin:<item>` | `Listing.gtin/gtinCheckedAt` + `ListingVariation` | empty GTIN → asked, none; empty variation GTINs skipped |
| `ApiCache` `catalog:<item>` | `Listing.title/catalogProductId/catalogCheckedAt/matchedEan/searchText` | `searchText` = lower-cased, accent-free `title + description`, same as `normalizeText`. Listings the cache only knew through a search (no title) take the title of their latest sale |
| `ApiCache` `seller:<id>` | `Seller` | global: one row per seller, newest nickname wins |
| `Snapshot` | `Snapshot` **in place** | `ownerId` → `accountId`, `month` → `char(7)`, `computedAt` → `timestamptz` (old values were UTC) |
| `MatchDecision` | `MatchDecision` **in place** | `ownerId` → `accountId`, `decision` → enum, `decidedAt` → `timestamptz` |
| `MarketResearch` | `MarketScan` + `MarketOffer` | kept points first (`position` 0…n-1), then excluded ones with their reason; the catalog title / canonical permalink are stored as null |
| (new) | `SaleLine` | **not backfilled**: derived data, rebuilt by the first sync and by "Recalcular histórico" |

## Safeguards built in

1. **One transaction.** The file runs all-or-nothing.
2. **Self-verification.** The last block compares the new tables with the legacy ones (row counts, sums of revenue / fees / shipping / taxes / offer prices, distinct sellers…) and raises an exception on any difference, which rolls the whole migration back.
3. **Repeatable fixture test.** `scripts/test-migration.sh` builds the old schema, loads `prisma/migration-tests/normalize_schema.seed.sql` (shared payments, a duplicate order in two month blobs, v1 keys, pre-split taxes, search-only catalog entries, a seller cached by two tenants…), applies the migration and checks about 40 expectations, including that deleting an account cascades.
4. **Equivalence test** (run once, during development). The old code (from `HEAD`) built a legacy database with demo data and match decisions; after the migration the new code recomputed three owner/month dashboards and every key of every payload was identical to what the old code had produced.
5. **No drift.** `prisma migrate diff` between a migrated database and `schema.prisma` is empty.

Measured duration: **17 s** for 246k legacy rows (120k orders, 120k payments, 120k shipments), including the verification block.

## Rehearsal on a real database

The migration was run on a dump of the production-shaped database (2 users, 13,776 cache rows, 7 months of orders), restored into a throwaway PostgreSQL 16 database:

| Check | Result |
|---|---|
| `prisma migrate deploy` | succeeds in **3.2 s**, own verification block passes |
| Drift (`prisma migrate diff` migrated DB vs `schema.prisma`) | empty |
| Rows created | 4,148 orders / items, 4,352 order-payment links, 4,634 payments with 9,064 tax lines, 4,374 shipments, 449 listings, 211 products, 17 market scans with 156 offers |
| Orders rebuilt from the new tables vs the legacy JSON | all 4,148 identical (payments compared as a set: the API order is not kept) |
| Listings without a title | 61 before the title backfill, 0 after |
| **Dashboards recomputed offline** by the old code on the legacy tables and by the new code on the migrated tables, same inputs, same clock, no Mercado Libre calls | identical for all six months, except the 7 month-boundary orders the old code counted twice (ANALYSIS.md C5): 2 lines in May (ARS 417,998), 2 in June (ARS 176,998), 3 in August (ARS 220,898), and July's comparison base and tax calibration that depend on June |

Not testable offline: November, the live month at dump time (the old code never stored the current month's orders), so it is rebuilt by the first sync.

The dump was made with PostgreSQL 17 tools and restored with a local `pg_restore` 18 converted to plain SQL, because the Docker database is version 16 and cannot read the newer format.

## Rollout

Pre-flight (production):

```bash
# 1. a restorable backup, taken right before
pg_dump "$DATABASE_URL" -Fc -f pnl-before-normalize.dump

# 2. rehearse on a copy first
createdb pnl_rehearsal && pg_restore -d pnl_rehearsal --no-owner pnl-before-normalize.dump
DATABASE_URL=postgresql://…/pnl_rehearsal pnpm prisma migrate deploy
```

Deploy (the `Dockerfile` already runs `prisma migrate deploy` before starting the server, so deploying the image applies it):

```bash
pnpm prisma migrate deploy
```

Requirements: the database user must be allowed to `CREATE EXTENSION pg_trgm` (a trusted extension since PostgreSQL 13, so the database owner can). The new code and the migration ship together: the code no longer reads the legacy tables, and the old code cannot run against the migrated `Snapshot`/`MatchDecision` columns. Plan a short window; there is no dual-write period.

After deploy:

1. Open the dashboard once: the first sync fills `SaleLine` for the current month and any "asked again" payments.
2. Press **Recalcular histórico** to fill `SaleLine` and refresh snapshots for every earlier month. Closed months are read from `Order`, so this makes no Mercado Libre calls for months already final.
3. Check the numbers against the old dashboard for a month you know. Useful sanity queries:

```sql
SELECT 'orders' AS t, count(*) FROM "Order"
UNION ALL SELECT 'lines', count(*) FROM "OrderItem"
UNION ALL SELECT 'payments with detail', count(*) FROM "Payment" WHERE "taxTotal" IS NOT NULL
UNION ALL SELECT 'sale lines', count(*) FROM "SaleLine";

-- shared payments (see ANALYSIS.md C1)
SELECT "paymentId", count(*) FROM "OrderPayment" GROUP BY 1 HAVING count(*) > 1;
```

## Rollback

Before the contract step, the legacy tables still hold the original data, but the migrated `Snapshot` and `MatchDecision` columns have changed, so the old code cannot simply be pointed back at the database. Roll back by **restoring the backup** (`pg_restore`) and redeploying the previous version. The legacy tables being kept is not a rollback mechanism; it is what lets a wrong backfill be inspected and re-run.

## Contract step: dropping the legacy tables

Do this in a later release, after at least one full week on the new schema and a checked backup. The SQL is prepared in [`prisma/pending/drop_legacy_tables.sql`](../../prisma/pending/drop_legacy_tables.sql). To apply it:

1. Delete the four `@deprecated` models (`MlToken`, `ApiCache`, `UserWorkbook`, `MarketResearch`) from `prisma/schema.prisma`.
2. `git mv prisma/pending/drop_legacy_tables.sql prisma/migrations/<timestamp>_drop_legacy_tables/migration.sql`.
3. Add its entry to [CHANGELOG.md](CHANGELOG.md), run `pnpm db:docs`, and run the tests.

(The test suite already fails if any code under `src/` touches the deprecated tables.)
