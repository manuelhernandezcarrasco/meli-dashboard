# S0 — Schema, migration, contracts, router stubs (run ALONE, first)

## Goal
Create every table, enum, shared type and empty router the other tickets build on, so they can run in parallel without touching shared files.

## Files you own
`prisma/schema.prisma`, `prisma/migrations/*` (one new migration), `prisma/migration-tests/*` (if needed), `docs/database/CHANGELOG.md`, `docs/database/SCHEMA.md` (generated), `docs/database/README.md` ("Who writes what" rows), `src/lib/stock-contracts.ts`, `src/server/stock/contracts.ts`, `src/server/api/routers/stock-{products,invoices,alerts,returns,sync}.ts` (empty routers), `src/server/api/root.ts` (register them).

## Conventions (from docs/database/README.md — follow all)
Tenant-first composite PKs `(accountId, …)`, composite FKs, `///` comment on every model and non-obvious column, `Decimal(16,4)` money, `Decimal(14,3)` quantities, `timestamptz`, no JSON for facts, `Marketplace` enum on marketplace-keyed rows, add `Account` back-relations. Surrogate ids: pick the Prisma pattern that still allows composite FKs `(accountId, id)` (e.g. `id BigInt @default(autoincrement())` plus `@@unique([accountId, id])` and reference that).

## Models (columns are the minimum; add `///` docs)

**Enums:** `MovementType` (`initial_count, purchase_in, sale, sale_cancel, return_restock, repair_in, repair_out, loss, manual_adjust, excel_reset`), `SyncMode` (`dry_run, live`), `AlertType` (`low_stock, out_of_stock, negative_stock, push_failed, stock_drift, margin_drop, unmatched_sale, suggested_match, auto_match, missing_cost, unmatched_listing, link_cost_review`), `AlertStatus` (`open, acknowledged, resolved`), `InvoiceStatus` (`draft, applied, voided`), `ReturnOutcome` (`pending, lost, in_repair, restocked`), `PushResult` (`dry_run, ok, failed, skipped`).

- **InventoryProduct** — master of what we stock. `id`, `accountId`, `ean String?` (GTIN-13, unique per account when set), `sku String?`, `name`, `model`, `category`, `minUnits Decimal?` (optional override of the day-based thresholds), `onHand Decimal(14,3)` (cache; derived from movements), `inRepair Decimal(14,3)`, `unitCost Decimal(16,4)` (current weighted cost, gross), `syncMode SyncMode @default(dry_run)`, `archivedAt`, `createdAt`, `updatedAt`. Index `(accountId, ean)`, `(accountId, category)`.
- **StockMovement** — append-only. `id`, `accountId`, `productId`, `type MovementType`, `quantity Decimal` (signed, + in / − out), `occurredAt`, `recordedAt`, `onHandAfter`, `unitCostAfter`, `idempotencyKey` (unique per account), `refType String?`/`refId String?` (e.g. `order`/`<orderId>:<lineNo>`, `invoice`/`<id>`, `return`/`<id>`), `reason String?`, `actor String` (`system`/`user`/`webhook`). **No update/delete anywhere in code.**
- **ProductCostEntry** — cost history for freezing sale cost. `id`, `accountId`, `productId`, `effectiveFrom timestamptz`, `unitCost Decimal(16,4)`, `onHandAtChange`, `reason` (`invoice`/`excel`/`initial`/`manual`), `refType`/`refId`, `note`. Index `(accountId, productId, effectiveFrom DESC)`.
- **PurchaseInvoice** — `id`, `accountId`, `supplierName`, `supplierTaxId`, `number` (e.g. `0225-00085935`), `issueDate date`, `currency` (default `ARS`), `subtotal`, `ivaAmount`, `perceptionsAmount`, `otherTaxesAmount`, `total`, `feeFactor Decimal(12,8)`, `feeFactorOverridden Boolean`, `status InvoiceStatus`, `appliedAt?`, `createdAt`, `sourceFileName`. Unique `(accountId, supplierTaxId, number)` (duplicate-invoice guard).
- **PurchaseInvoiceLine** — `(accountId, invoiceId, lineNo)` PK, `supplierCode`, `ean` (normalized GTIN-13 or null), `description`, `quantity`, `unitPrice`, `discount`, `lineSubtotal`, `landedUnitCost`, `productId?` (resolved), `resolution` (`auto_ean`, `manual_match`, `created_product`, `unresolved`).
- **ListingLink** — maps a marketplace listing/variation to what we stock. `id`, `accountId`, `marketplace`, `itemId`, `variationId BigInt?`, `createdAt`. Unique on `(accountId, marketplace, itemId, variationId)` treating NULL as distinct-value (use a unique index with `COALESCE(variationId, 0)` in raw SQL in the migration).
- **ListingLinkComponent** — `(accountId, linkId, productId)` PK, `quantity Decimal(14,3) default 1`.
- **ListingSyncState** — per link: `linkId` PK, `lastObservedMlQty Int?`, `lastObservedAt?`, `lastPushedQty Int?`, `lastPushedAt?`, `status` (`never`, `in_sync`, `drift`, `failed`), `lastError?`.
- **MlPushLog** — append-only. `id`, `accountId`, `marketplace`, `itemId`, `variationId?`, `requestedQty`, `previousMlQty?`, `mode SyncMode`, `result PushResult`, `httpStatus?`, `error?`, `triggerType` (`sale`,`invoice`,`adjust`,`reconcile`,`manual`), `triggerRef?`, `createdAt`.
- **StockAlert** — `id`, `accountId`, `type AlertType`, `status`, `productId?`, `marketplace?`, `itemId?`, `dedupeKey` (unique per account while not resolved), `title`, `detail`, numeric context columns (`quantity?`, `amount?`), `createdAt`, `acknowledgedAt?`, `resolvedAt?`, `resolution String?`.
- **ReturnCase** — `id`, `accountId`, `marketplace`, `orderId BigInt`, `lineNo`, `productId`, `quantity`, `outcome ReturnOutcome`, `reason?`, `openedAt`, `resolvedAt?`, `note?`. Unique `(accountId, marketplace, orderId, lineNo)`.
- **WebhookEvent** — inbox. `id`, `accountId?`, `marketplace`, `topic`, `resource`, `receivedAt`, `processedAt?`, `error?`. Unique `(marketplace, topic, resource, receivedAt)`-like key to drop exact duplicates (use `externalEventId` when ML gives one).
- **InventorySettings** — `accountId` PK, `cutoverAt timestamptz?`, `defaultSyncMode`, `lastReconcileAt?`.

## Contracts to write (zod + TS)
`src/lib/stock-contracts.ts`: schemas for every router input/output (product list row, product detail, movement row, invoice draft/review payload, alert row, return row, push log row, sync status). `src/server/stock/contracts.ts`: the **service interfaces** the other tickets implement and consume, e.g.
`appendMovement(input): Promise<MovementResult>`, `costAt(accountId, productId, at): Promise<Decimal>`, `availableQuantity(components): number`, `requestPush(accountId, productIds, trigger): Promise<void>`, `raiseAlert(input)`, `parseInvoicePdf(buffer): ParsedInvoice`, `linkListing(...)`. Document each with a one-line contract and error cases. Others code against these signatures with fakes until the real thing merges.

## Router stubs
Five empty `createTRPCRouter({})` files using `linkedProcedure`/`protectedProcedure`, registered in `root.ts` as `stockProducts`, `stockInvoices`, `stockAlerts`, `stockReturns`, `stockSync`.

## Docs
Migration + CHANGELOG entry + `pnpm db:docs`; extend "Who writes what" in `docs/database/README.md` with the stock writers named in `PLAN.md`. Update `docs/database/cookbook.sql` with two example queries (movements per product, weighted cost history).

## Done when
`pnpm prisma migrate dev` applies cleanly on a fresh DB; `pnpm db:docs` output committed; docs tests pass; `pnpm typecheck && pnpm lint && pnpm test` green; no code outside the owned files changed.
