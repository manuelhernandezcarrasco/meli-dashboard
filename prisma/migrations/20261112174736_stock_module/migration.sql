-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('initial_count', 'purchase_in', 'sale', 'sale_cancel', 'return_restock', 'repair_in', 'repair_out', 'loss', 'manual_adjust', 'excel_reset');

-- CreateEnum
CREATE TYPE "SyncMode" AS ENUM ('dry_run', 'live');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('low_stock', 'out_of_stock', 'negative_stock', 'push_failed', 'stock_drift', 'margin_drop', 'unmatched_sale', 'suggested_match', 'auto_match', 'missing_cost', 'unmatched_listing', 'link_cost_review');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('open', 'acknowledged', 'resolved');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'applied', 'voided');

-- CreateEnum
CREATE TYPE "ReturnOutcome" AS ENUM ('pending', 'lost', 'in_repair', 'restocked');

-- CreateEnum
CREATE TYPE "PushResult" AS ENUM ('dry_run', 'ok', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "LineResolution" AS ENUM ('auto_ean', 'manual_match', 'created_product', 'unresolved');

-- CreateEnum
CREATE TYPE "CostReason" AS ENUM ('invoice', 'excel', 'initial', 'manual');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('never', 'in_sync', 'drift', 'failed');

-- CreateEnum
CREATE TYPE "PushTrigger" AS ENUM ('sale', 'invoice', 'adjust', 'reconcile', 'manual');

-- CreateTable
CREATE TABLE "InventoryProduct" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "ean" TEXT,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "minUnits" DECIMAL(14,3),
    "onHand" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "inRepair" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "syncMode" "SyncMode" NOT NULL DEFAULT 'dry_run',
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryProduct_pkey" PRIMARY KEY ("accountId","id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" BIGINT NOT NULL,
    "type" "MovementType" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "onHandAfter" DECIMAL(14,3) NOT NULL,
    "unitCostAfter" DECIMAL(16,4) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "reason" TEXT,
    "actor" TEXT NOT NULL,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("accountId","id")
);

-- CreateTable
CREATE TABLE "ProductCostEntry" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" BIGINT NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "unitCost" DECIMAL(16,4) NOT NULL,
    "onHandAtChange" DECIMAL(14,3) NOT NULL,
    "reason" "CostReason" NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "note" TEXT,

    CONSTRAINT "ProductCostEntry_pkey" PRIMARY KEY ("accountId","id")
);

-- CreateTable
CREATE TABLE "PurchaseInvoice" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "supplierTaxId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issueDate" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "subtotal" DECIMAL(16,4) NOT NULL,
    "ivaAmount" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "perceptionsAmount" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "otherTaxesAmount" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(16,4) NOT NULL,
    "feeFactor" DECIMAL(12,8) NOT NULL,
    "feeFactorOverridden" BOOLEAN NOT NULL DEFAULT false,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "appliedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceFileName" TEXT NOT NULL,

    CONSTRAINT "PurchaseInvoice_pkey" PRIMARY KEY ("accountId","id")
);

-- CreateTable
CREATE TABLE "PurchaseInvoiceLine" (
    "accountId" TEXT NOT NULL,
    "invoiceId" BIGINT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "supplierCode" TEXT NOT NULL DEFAULT '',
    "ean" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(16,4) NOT NULL,
    "discount" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "lineSubtotal" DECIMAL(16,4) NOT NULL,
    "landedUnitCost" DECIMAL(16,4) NOT NULL,
    "productId" BIGINT,
    "resolution" "LineResolution" NOT NULL DEFAULT 'unresolved',

    CONSTRAINT "PurchaseInvoiceLine_pkey" PRIMARY KEY ("accountId","invoiceId","lineNo")
);

-- CreateTable
CREATE TABLE "ListingLink" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "itemId" TEXT NOT NULL,
    "variationId" BIGINT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingLink_pkey" PRIMARY KEY ("accountId","id")
);

-- CreateTable
CREATE TABLE "ListingLinkComponent" (
    "accountId" TEXT NOT NULL,
    "linkId" BIGINT NOT NULL,
    "productId" BIGINT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 1,

    CONSTRAINT "ListingLinkComponent_pkey" PRIMARY KEY ("accountId","linkId","productId")
);

-- CreateTable
CREATE TABLE "ListingSyncState" (
    "accountId" TEXT NOT NULL,
    "linkId" BIGINT NOT NULL,
    "lastObservedMlQty" INTEGER,
    "lastObservedAt" TIMESTAMPTZ(3),
    "lastPushedQty" INTEGER,
    "lastPushedAt" TIMESTAMPTZ(3),
    "status" "SyncStatus" NOT NULL DEFAULT 'never',
    "lastError" TEXT,

    CONSTRAINT "ListingSyncState_pkey" PRIMARY KEY ("accountId","linkId")
);

-- CreateTable
CREATE TABLE "MlPushLog" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "itemId" TEXT NOT NULL,
    "variationId" BIGINT,
    "requestedQty" INTEGER NOT NULL,
    "previousMlQty" INTEGER,
    "mode" "SyncMode" NOT NULL,
    "result" "PushResult" NOT NULL,
    "httpStatus" INTEGER,
    "error" TEXT,
    "triggerType" "PushTrigger" NOT NULL,
    "triggerRef" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlPushLog_pkey" PRIMARY KEY ("accountId","id")
);

-- CreateTable
CREATE TABLE "StockAlert" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'open',
    "productId" BIGINT,
    "marketplace" "Marketplace",
    "itemId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "quantity" DECIMAL(14,3),
    "amount" DECIMAL(16,4),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "resolution" TEXT,

    CONSTRAINT "StockAlert_pkey" PRIMARY KEY ("accountId","id")
);

-- CreateTable
CREATE TABLE "ReturnCase" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "orderId" BIGINT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productId" BIGINT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "outcome" "ReturnOutcome" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "note" TEXT,

    CONSTRAINT "ReturnCase_pkey" PRIMARY KEY ("accountId","id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT,
    "marketplace" "Marketplace" NOT NULL,
    "topic" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "externalEventId" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),
    "error" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySettings" (
    "accountId" TEXT NOT NULL,
    "cutoverAt" TIMESTAMPTZ(3),
    "defaultSyncMode" "SyncMode" NOT NULL DEFAULT 'dry_run',
    "lastReconcileAt" TIMESTAMPTZ(3),

    CONSTRAINT "InventorySettings_pkey" PRIMARY KEY ("accountId")
);

-- CreateIndex
CREATE INDEX "InventoryProduct_accountId_category_idx" ON "InventoryProduct"("accountId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryProduct_accountId_ean_key" ON "InventoryProduct"("accountId", "ean");

-- CreateIndex
CREATE INDEX "StockMovement_accountId_productId_occurredAt_idx" ON "StockMovement"("accountId", "productId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "StockMovement_accountId_refType_refId_idx" ON "StockMovement"("accountId", "refType", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_accountId_idempotencyKey_key" ON "StockMovement"("accountId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ProductCostEntry_accountId_productId_effectiveFrom_idx" ON "ProductCostEntry"("accountId", "productId", "effectiveFrom" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseInvoice_accountId_supplierTaxId_number_key" ON "PurchaseInvoice"("accountId", "supplierTaxId", "number");

-- CreateIndex
CREATE INDEX "PurchaseInvoiceLine_accountId_productId_idx" ON "PurchaseInvoiceLine"("accountId", "productId");

-- CreateIndex
CREATE INDEX "ListingLink_accountId_marketplace_itemId_idx" ON "ListingLink"("accountId", "marketplace", "itemId");

-- CreateIndex
CREATE INDEX "ListingLinkComponent_accountId_productId_idx" ON "ListingLinkComponent"("accountId", "productId");

-- CreateIndex
CREATE INDEX "MlPushLog_accountId_marketplace_itemId_createdAt_idx" ON "MlPushLog"("accountId", "marketplace", "itemId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "StockAlert_accountId_status_type_idx" ON "StockAlert"("accountId", "status", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnCase_accountId_marketplace_orderId_lineNo_key" ON "ReturnCase"("accountId", "marketplace", "orderId", "lineNo");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_idx" ON "WebhookEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_marketplace_externalEventId_key" ON "WebhookEvent"("marketplace", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_marketplace_topic_resource_receivedAt_key" ON "WebhookEvent"("marketplace", "topic", "resource", "receivedAt");

-- AddForeignKey
ALTER TABLE "InventoryProduct" ADD CONSTRAINT "InventoryProduct_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "InventoryProduct"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCostEntry" ADD CONSTRAINT "ProductCostEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCostEntry" ADD CONSTRAINT "ProductCostEntry_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "InventoryProduct"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseInvoice" ADD CONSTRAINT "PurchaseInvoice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseInvoiceLine" ADD CONSTRAINT "PurchaseInvoiceLine_accountId_invoiceId_fkey" FOREIGN KEY ("accountId", "invoiceId") REFERENCES "PurchaseInvoice"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseInvoiceLine" ADD CONSTRAINT "PurchaseInvoiceLine_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "InventoryProduct"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseInvoiceLine" ADD CONSTRAINT "PurchaseInvoiceLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingLink" ADD CONSTRAINT "ListingLink_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingLinkComponent" ADD CONSTRAINT "ListingLinkComponent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingLinkComponent" ADD CONSTRAINT "ListingLinkComponent_accountId_linkId_fkey" FOREIGN KEY ("accountId", "linkId") REFERENCES "ListingLink"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingLinkComponent" ADD CONSTRAINT "ListingLinkComponent_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "InventoryProduct"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingSyncState" ADD CONSTRAINT "ListingSyncState_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingSyncState" ADD CONSTRAINT "ListingSyncState_accountId_linkId_fkey" FOREIGN KEY ("accountId", "linkId") REFERENCES "ListingLink"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MlPushLog" ADD CONSTRAINT "MlPushLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAlert" ADD CONSTRAINT "StockAlert_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAlert" ADD CONSTRAINT "StockAlert_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "InventoryProduct"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnCase" ADD CONSTRAINT "ReturnCase_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnCase" ADD CONSTRAINT "ReturnCase_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "InventoryProduct"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnCase" ADD CONSTRAINT "ReturnCase_accountId_marketplace_orderId_lineNo_fkey" FOREIGN KEY ("accountId", "marketplace", "orderId", "lineNo") REFERENCES "OrderItem"("accountId", "marketplace", "orderId", "lineNo") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventorySettings" ADD CONSTRAINT "InventorySettings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes Prisma cannot express ------------------------------------------------------------
-- One link per listing/variation; a NULL variation (whole listing) counts as a single value.
CREATE UNIQUE INDEX "ListingLink_listing_variation_key"
  ON "ListingLink" ("accountId", "marketplace", "itemId", COALESCE("variationId", 0));

-- One live alert per situation: resolved alerts may repeat the same dedupeKey.
CREATE UNIQUE INDEX "StockAlert_open_dedupe_key"
  ON "StockAlert" ("accountId", "dedupeKey") WHERE "status" <> 'resolved';

-- Ledger sanity: no zero-quantity movements.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_quantity_nonzero" CHECK ("quantity" <> 0);
