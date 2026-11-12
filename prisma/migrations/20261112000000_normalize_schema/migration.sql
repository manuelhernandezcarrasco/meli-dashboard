-- Normalize the schema: split the ApiCache / UserWorkbook / MlToken / MarketResearch JSON stores
-- into typed, related tables and copy every legacy row into them.
--
-- EXPAND step of an expand/contract migration:
--   * new tables are created and filled from the legacy ones;
--   * Snapshot and MatchDecision are altered IN PLACE (no row is rewritten, columns are renamed
--     and retyped);
--   * the legacy tables MlToken, ApiCache, UserWorkbook and MarketResearch are left untouched so
--     a wrong backfill can be diagnosed and re-run; they are dropped by a later migration.
-- The whole file runs in one transaction. The verification block at the end compares what was
-- copied with what the legacy tables hold and aborts (rolling everything back) on any mismatch.
-- Mapping and rationale: docs/database/MIGRATION.md

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Same normalization as `normalizeText` in src/server/market/ownProducts.ts (lower case, no accents).
CREATE FUNCTION pg_temp.norm_text(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(translate(lower(coalesce(t, '')), 'áàâäãåéèêëíìîïóòôöõúùûüñç', 'aaaaaaeeeeiiiiooooouuuunc'))
$$;

-- ═══ Types and tables ═══
-- CreateEnum
CREATE TYPE "UploadKind" AS ENUM ('pnl', 'inputs');

-- CreateEnum
CREATE TYPE "MappingKind" AS ENUM ('item', 'sku');

-- CreateEnum
CREATE TYPE "MatchVerdict" AS ENUM ('confirmed', 'rejected');

-- CreateEnum
CREATE TYPE "Marketplace" AS ENUM ('mercadolibre');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('marketplace', 'direct');

-- CreateEnum
CREATE TYPE "OfferExclusion" AS ENUM ('price_outlier', 'sales_outlier', 'cap');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- ─── 1. Tenants ──────────────────────────────────────────────────────────────
-- Every owner that appears in any legacy table becomes an Account (created at the earliest
-- timestamp we know for it).
INSERT INTO "Account" ("id", "createdAt")
SELECT s."ownerId", COALESCE(min(s.ts) AT TIME ZONE 'UTC', CURRENT_TIMESTAMP)
FROM (
  SELECT "ownerId", "updatedAt" AS ts FROM "MlToken"
  UNION ALL SELECT "ownerId", "updatedAt" FROM "ApiCache"
  UNION ALL SELECT "ownerId", "computedAt" FROM "Snapshot"
  UNION ALL SELECT "ownerId", "uploadedAt" FROM "UserWorkbook"
  UNION ALL SELECT "ownerId", "decidedAt" FROM "MatchDecision"
  UNION ALL SELECT "ownerId", "fetchedAt" FROM "MarketResearch"
) s
GROUP BY s."ownerId";

-- ─── 2. In-place changes of the two tables that keep their identity ──────────
ALTER TABLE "Snapshot" RENAME COLUMN "ownerId" TO "accountId";
ALTER TABLE "Snapshot"
  ALTER COLUMN "month" TYPE CHAR(7),
  ALTER COLUMN "computedAt" TYPE TIMESTAMPTZ(3) USING "computedAt" AT TIME ZONE 'UTC';

ALTER TABLE "MatchDecision" RENAME COLUMN "ownerId" TO "accountId";
ALTER TABLE "MatchDecision"
  ADD COLUMN "marketplace" "Marketplace" NOT NULL DEFAULT 'mercadolibre', -- every legacy decision is about a Mercado Libre listing
  ALTER COLUMN "decision" TYPE "MatchVerdict" USING "decision"::"MatchVerdict",
  ALTER COLUMN "decidedAt" TYPE TIMESTAMPTZ(3) USING "decidedAt" AT TIME ZONE 'UTC';
ALTER TABLE "MatchDecision" ALTER COLUMN "marketplace" DROP DEFAULT;
ALTER TABLE "MatchDecision" DROP CONSTRAINT "MatchDecision_pkey",
  ADD CONSTRAINT "MatchDecision_pkey" PRIMARY KEY ("accountId", "marketplace", "itemId", "ean");

-- CreateTable
CREATE TABLE "MarketplaceConnection" (
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "linkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceConnection_pkey" PRIMARY KEY ("accountId","marketplace")
);

-- CreateTable
CREATE TABLE "Upload" (
    "accountId" TEXT NOT NULL,
    "kind" "UploadKind" NOT NULL,
    "fileName" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("accountId","kind")
);

-- CreateTable
CREATE TABLE "Product" (
    "accountId" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unitCost" DOUBLE PRECISION NOT NULL,
    "stockFinal" DOUBLE PRECISION NOT NULL,
    "assumedMargin" DOUBLE PRECISION NOT NULL,
    "prevMlCostPct" DOUBLE PRECISION,
    "prevUnits" DOUBLE PRECISION NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("accountId","ean")
);

-- CreateTable
CREATE TABLE "PnlClosing" (
    "accountId" TEXT NOT NULL,
    "salesMl" DOUBLE PRECISION NOT NULL,
    "salesDirect" DOUBLE PRECISION NOT NULL,
    "sales" DOUBLE PRECISION NOT NULL,
    "mlCosts" DOUBLE PRECISION NOT NULL,
    "cogs" DOUBLE PRECISION NOT NULL,
    "units" DOUBLE PRECISION NOT NULL,
    "netIncome" DOUBLE PRECISION NOT NULL,
    "margin" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PnlClosing_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "CostOverride" (
    "accountId" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "unitCost" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,

    CONSTRAINT "CostOverride_pkey" PRIMARY KEY ("accountId","ean")
);

-- CreateTable
CREATE TABLE "ProductMapping" (
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "kind" "MappingKind" NOT NULL,
    "key" TEXT NOT NULL,
    "ean" TEXT NOT NULL,

    CONSTRAINT "ProductMapping_pkey" PRIMARY KEY ("accountId","marketplace","kind","key")
);

-- CreateTable
CREATE TABLE "DirectSale" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "saleDate" DATE NOT NULL,
    "customer" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(16,4) NOT NULL,

    CONSTRAINT "DirectSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReceipt" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "receiptDate" DATE NOT NULL,
    "ean" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "StockReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "itemId" TEXT NOT NULL,
    "title" TEXT,
    "catalogProductId" TEXT,
    "catalogCheckedAt" TIMESTAMPTZ(3),
    "gtin" TEXT,
    "gtinCheckedAt" TIMESTAMPTZ(3),
    "matchedEan" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("accountId","marketplace","itemId")
);

-- CreateTable
CREATE TABLE "ListingVariation" (
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "itemId" TEXT NOT NULL,
    "variationId" BIGINT NOT NULL,
    "gtin" TEXT NOT NULL,

    CONSTRAINT "ListingVariation_pkey" PRIMARY KEY ("accountId","marketplace","itemId","variationId")
);

-- CreateTable
CREATE TABLE "Seller" (
    "marketplace" "Marketplace" NOT NULL,
    "sellerId" BIGINT NOT NULL,
    "nickname" TEXT NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Seller_pkey" PRIMARY KEY ("marketplace","sellerId")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "shippingId" BIGINT NOT NULL,
    "sellerCost" DECIMAL(16,4),
    "costFetchedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("accountId","marketplace","shippingId")
);

-- CreateTable
CREATE TABLE "Order" (
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "orderId" BIGINT NOT NULL,
    "packId" BIGINT,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "shippingId" BIGINT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("accountId","marketplace","orderId")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "orderId" BIGINT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sellerSku" TEXT,
    "sellerCustomField" TEXT,
    "variationId" BIGINT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(16,4) NOT NULL,
    "saleFee" DECIMAL(16,4) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("accountId","marketplace","orderId","lineNo")
);

-- CreateTable
CREATE TABLE "Payment" (
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "paymentId" BIGINT NOT NULL,
    "taxTotal" DECIMAL(16,4),
    "financingFee" DECIMAL(16,4),
    "taxFetchedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("accountId","marketplace","paymentId")
);

-- CreateTable
CREATE TABLE "PaymentTax" (
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "paymentId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(16,4) NOT NULL,

    CONSTRAINT "PaymentTax_pkey" PRIMARY KEY ("accountId","marketplace","paymentId","name")
);

-- CreateTable
CREATE TABLE "OrderPayment" (
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "orderId" BIGINT NOT NULL,
    "paymentId" BIGINT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "OrderPayment_pkey" PRIMARY KEY ("accountId","marketplace","orderId","paymentId")
);

-- CreateTable
CREATE TABLE "OrderPeriod" (
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "month" CHAR(7) NOT NULL,
    "isFinal" BOOLEAN NOT NULL,
    "orderCount" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderPeriod_pkey" PRIMARY KEY ("accountId","marketplace","month")
);

-- CreateTable
CREATE TABLE "SaleLine" (
    "accountId" TEXT NOT NULL,
    "period" CHAR(7) NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "saleDate" DATE NOT NULL,
    "saleTime" VARCHAR(5) NOT NULL,
    "marketplace" "Marketplace",
    "channel" "Channel" NOT NULL,
    "orderRef" TEXT NOT NULL,
    "itemId" TEXT,
    "sku" TEXT,
    "ean" TEXT,
    "matchVia" TEXT NOT NULL,
    "matchScore" DOUBLE PRECISION,
    "suggestedEan" TEXT,
    "description" TEXT NOT NULL,
    "listingTitle" TEXT,
    "category" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(16,4) NOT NULL,
    "revenue" DECIMAL(16,4) NOT NULL,
    "saleFee" DECIMAL(16,4) NOT NULL,
    "financingFee" DECIMAL(16,4) NOT NULL,
    "shippingCost" DECIMAL(16,4) NOT NULL,
    "taxAmount" DECIMAL(16,4) NOT NULL,
    "marketplaceCost" DECIMAL(16,4) NOT NULL,
    "unitCost" DOUBLE PRECISION NOT NULL,
    "cogs" DECIMAL(16,4) NOT NULL,
    "costSource" TEXT NOT NULL,
    "taxSource" TEXT NOT NULL,
    "taxDetail" TEXT,

    CONSTRAINT "SaleLine_pkey" PRIMARY KEY ("accountId","period","lineNo")
);

-- CreateTable
CREATE TABLE "MarketScan" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "catalogProductId" TEXT NOT NULL,
    "catalogTitle" TEXT NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "regression" JSONB NOT NULL,

    CONSTRAINT "MarketScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketOffer" (
    "scanId" BIGINT NOT NULL,
    "position" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "sellerId" BIGINT NOT NULL,
    "title" TEXT,
    "price" DECIMAL(16,4) NOT NULL,
    "soldQuantity" INTEGER,
    "soldExact" BOOLEAN NOT NULL,
    "isOurs" BOOLEAN NOT NULL,
    "permalink" TEXT,
    "excluded" "OfferExclusion",

    CONSTRAINT "MarketOffer_pkey" PRIMARY KEY ("scanId","position")
);

-- CreateIndex
CREATE INDEX "Product_accountId_category_idx" ON "Product"("accountId", "category");

-- CreateIndex
CREATE INDEX "ProductMapping_accountId_marketplace_ean_idx" ON "ProductMapping"("accountId", "marketplace", "ean");

-- CreateIndex
CREATE INDEX "DirectSale_accountId_saleDate_idx" ON "DirectSale"("accountId", "saleDate");

-- CreateIndex
CREATE INDEX "DirectSale_accountId_ean_idx" ON "DirectSale"("accountId", "ean");

-- CreateIndex
CREATE INDEX "StockReceipt_accountId_receiptDate_idx" ON "StockReceipt"("accountId", "receiptDate");

-- CreateIndex
CREATE INDEX "StockReceipt_accountId_ean_idx" ON "StockReceipt"("accountId", "ean");

-- CreateIndex
CREATE INDEX "Listing_accountId_marketplace_catalogProductId_idx" ON "Listing"("accountId", "marketplace", "catalogProductId");

-- CreateIndex
CREATE INDEX "Listing_searchText_idx" ON "Listing" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Order_accountId_createdAt_idx" ON "Order"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_accountId_marketplace_shippingId_idx" ON "Order"("accountId", "marketplace", "shippingId");

-- CreateIndex
CREATE INDEX "OrderItem_accountId_marketplace_itemId_idx" ON "OrderItem"("accountId", "marketplace", "itemId");

-- CreateIndex
CREATE INDEX "OrderPayment_accountId_marketplace_paymentId_idx" ON "OrderPayment"("accountId", "marketplace", "paymentId");

-- CreateIndex
CREATE INDEX "SaleLine_accountId_saleDate_idx" ON "SaleLine"("accountId", "saleDate");

-- CreateIndex
CREATE INDEX "SaleLine_accountId_ean_saleDate_idx" ON "SaleLine"("accountId", "ean", "saleDate");

-- CreateIndex
CREATE INDEX "SaleLine_accountId_itemId_idx" ON "SaleLine"("accountId", "itemId");

-- CreateIndex
CREATE INDEX "MarketScan_accountId_marketplace_catalogProductId_fetchedAt_idx" ON "MarketScan"("accountId", "marketplace", "catalogProductId", "fetchedAt" DESC);

-- CreateIndex
CREATE INDEX "MarketOffer_itemId_idx" ON "MarketOffer"("itemId");

-- CreateIndex
CREATE INDEX "MarketOffer_sellerId_idx" ON "MarketOffer"("sellerId");

-- CreateIndex
CREATE INDEX "Snapshot_accountId_computedAt_idx" ON "Snapshot"("accountId", "computedAt" DESC);

-- CreateIndex
CREATE INDEX "MatchDecision_accountId_marketplace_itemId_idx" ON "MatchDecision"("accountId", "marketplace", "itemId");

-- NOTE (deferred foreign keys): Order->Shipment, OrderItem->Listing and OrderPayment->Payment are
-- DEFERRABLE INITIALLY DEFERRED. All of them also hang from "Account" with ON DELETE CASCADE, and
-- Postgres runs cascaded deletes one table at a time, checking NO ACTION per statement: deleting an
-- Account would otherwise fail as soon as "Listing" is removed before "OrderItem". Deferring the
-- check to COMMIT lets every cascade finish first. Prisma cannot express DEFERRABLE, so it only
-- lives here: never regenerate these three constraints from `prisma migrate dev` output.

-- AddForeignKey
ALTER TABLE "MarketplaceConnection" ADD CONSTRAINT "MarketplaceConnection_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PnlClosing" ADD CONSTRAINT "PnlClosing_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostOverride" ADD CONSTRAINT "CostOverride_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMapping" ADD CONSTRAINT "ProductMapping_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectSale" ADD CONSTRAINT "DirectSale_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReceipt" ADD CONSTRAINT "StockReceipt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchDecision" ADD CONSTRAINT "MatchDecision_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingVariation" ADD CONSTRAINT "ListingVariation_accountId_marketplace_itemId_fkey" FOREIGN KEY ("accountId", "marketplace", "itemId") REFERENCES "Listing"("accountId", "marketplace", "itemId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_marketplace_shippingId_fkey" FOREIGN KEY ("accountId", "marketplace", "shippingId") REFERENCES "Shipment"("accountId", "marketplace", "shippingId") ON DELETE NO ACTION ON UPDATE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_accountId_marketplace_orderId_fkey" FOREIGN KEY ("accountId", "marketplace", "orderId") REFERENCES "Order"("accountId", "marketplace", "orderId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_accountId_marketplace_itemId_fkey" FOREIGN KEY ("accountId", "marketplace", "itemId") REFERENCES "Listing"("accountId", "marketplace", "itemId") ON DELETE NO ACTION ON UPDATE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTax" ADD CONSTRAINT "PaymentTax_accountId_marketplace_paymentId_fkey" FOREIGN KEY ("accountId", "marketplace", "paymentId") REFERENCES "Payment"("accountId", "marketplace", "paymentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPayment" ADD CONSTRAINT "OrderPayment_accountId_marketplace_orderId_fkey" FOREIGN KEY ("accountId", "marketplace", "orderId") REFERENCES "Order"("accountId", "marketplace", "orderId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPayment" ADD CONSTRAINT "OrderPayment_accountId_marketplace_paymentId_fkey" FOREIGN KEY ("accountId", "marketplace", "paymentId") REFERENCES "Payment"("accountId", "marketplace", "paymentId") ON DELETE NO ACTION ON UPDATE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "OrderPeriod" ADD CONSTRAINT "OrderPeriod_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketScan" ADD CONSTRAINT "MarketScan_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketOffer" ADD CONSTRAINT "MarketOffer_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "MarketScan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Integrity rules Prisma cannot express ───────────────────────────────────
ALTER TABLE "Snapshot"    ADD CONSTRAINT "Snapshot_month_format"    CHECK ("month"  ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "OrderPeriod" ADD CONSTRAINT "OrderPeriod_month_format" CHECK ("month"  ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "SaleLine"    ADD CONSTRAINT "SaleLine_period_format"   CHECK ("period" ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "OrderItem"   ADD CONSTRAINT "OrderItem_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "SaleLine"    ADD CONSTRAINT "SaleLine_channel_marketplace" CHECK (("channel" = 'marketplace') = ("marketplace" IS NOT NULL));

-- ═════════════════════════════════════════════════════════════════════════════
-- BACKFILL
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── 3. MlToken -> MarketplaceConnection (every legacy row is Mercado Libre) ──────────────────────────────────────────────
INSERT INTO "MarketplaceConnection" ("accountId", "marketplace", "externalUserId", "accessToken", "refreshToken", "expiresAt", "linkedAt", "updatedAt")
SELECT "ownerId", 'mercadolibre'::"Marketplace", "userId"::text, "accessToken", "refreshToken",
       "expiresAt" AT TIME ZONE 'UTC', "updatedAt" AT TIME ZONE 'UTC', "updatedAt" AT TIME ZONE 'UTC'
FROM "MlToken";

-- ─── 4. UserWorkbook (one JSON blob per file) -> typed master data ───────────
INSERT INTO "Upload" ("accountId", "kind", "fileName", "rowCount", "uploadedAt")
SELECT w."ownerId", w."kind"::"UploadKind", w."fileName",
       CASE w."kind"
         WHEN 'pnl'    THEN (SELECT count(*) FROM jsonb_object_keys(COALESCE(w."payload"->'base', '{}'::jsonb)))
         ELSE COALESCE(jsonb_array_length(w."payload"->'va'), 0)
       END,
       w."uploadedAt" AT TIME ZONE 'UTC'
FROM "UserWorkbook" w;

-- P&L close: SKU base (key = EAN) and previous totals
INSERT INTO "Product" ("accountId", "ean", "description", "model", "category", "unitCost", "stockFinal", "assumedMargin", "prevMlCostPct", "prevUnits", "position")
SELECT w."ownerId", b.key,
       b.value->>'desc', b.value->>'modelo', b.value->>'cat',
       (b.value->>'cu')::float8, (b.value->>'stock')::float8, (b.value->>'mg')::float8,
       (b.value->>'costoMlPctPrev')::float8, (b.value->>'udsPrev')::float8,
       (b.ord - 1)::int  -- jsonb keeps keys in its canonical order, which is the order the app has always used
FROM "UserWorkbook" w, jsonb_each(w."payload"->'base') WITH ORDINALITY AS b(key, value, ord)
WHERE w."kind" = 'pnl';

INSERT INTO "PnlClosing" ("accountId", "salesMl", "salesDirect", "sales", "mlCosts", "cogs", "units", "netIncome", "margin")
SELECT w."ownerId",
       (w."payload"#>>'{prev,ventaMl}')::float8, (w."payload"#>>'{prev,ventaVa}')::float8, (w."payload"#>>'{prev,venta}')::float8,
       (w."payload"#>>'{prev,costoMl}')::float8, (w."payload"#>>'{prev,cogs}')::float8, (w."payload"#>>'{prev,uds}')::float8,
       (w."payload"#>>'{prev,ingNetos}')::float8, (w."payload"#>>'{prev,margen}')::float8
FROM "UserWorkbook" w
WHERE w."kind" = 'pnl' AND w."payload" ? 'prev';

-- Inputs file: overrides, mappings, direct sales, stock receipts
INSERT INTO "CostOverride" ("accountId", "ean", "unitCost", "description", "category")
SELECT w."ownerId", o.key, (o.value->>'cu')::float8, o.value->>'desc', o.value->>'cat'
FROM "UserWorkbook" w, jsonb_each(w."payload"->'override') o
WHERE w."kind" = 'inputs';

INSERT INTO "ProductMapping" ("accountId", "marketplace", "kind", "key", "ean")
SELECT w."ownerId", 'mercadolibre'::"Marketplace", 'item'::"MappingKind", m.key, m.value
FROM "UserWorkbook" w, jsonb_each_text(w."payload"->'mapItem') m
WHERE w."kind" = 'inputs'
UNION ALL
SELECT w."ownerId", 'mercadolibre'::"Marketplace", 'sku'::"MappingKind", m.key, m.value
FROM "UserWorkbook" w, jsonb_each_text(w."payload"->'mapSku') m
WHERE w."kind" = 'inputs';

INSERT INTO "DirectSale" ("accountId", "saleDate", "customer", "ean", "description", "quantity", "unitPrice")
SELECT w."ownerId", (v.value->>'date')::date, v.value->>'cliente', v.value->>'ean', v.value->>'desc',
       (v.value->>'qty')::numeric, (v.value->>'pu')::numeric
FROM "UserWorkbook" w, jsonb_array_elements(w."payload"->'va') WITH ORDINALITY AS v(value, ord)
WHERE w."kind" = 'inputs'
ORDER BY w."ownerId", v.ord;

INSERT INTO "StockReceipt" ("accountId", "receiptDate", "ean", "quantity")
SELECT w."ownerId", (v.value->>'date')::date, v.value->>'ean', (v.value->>'qty')::numeric
FROM "UserWorkbook" w, jsonb_array_elements(w."payload"->'ingresos') WITH ORDINALITY AS v(value, ord)
WHERE w."kind" = 'inputs'
ORDER BY w."ownerId", v.ord;

-- ─── 5. ApiCache `orders:YYYY-MM` blobs -> Order / OrderItem / OrderPayment ──
-- One row per order. If two month blobs hold the same order, the most recently written one wins. (Mercado
-- Libre filters months in the seller's own clock, so an order made minutes before midnight can be delivered
-- by two consecutive months' downloads; the old dashboards counted it in both. An order belongs to the
-- month of its own `createdAt`, so it is now counted once.)
CREATE TEMP TABLE _legacy_orders AS
SELECT DISTINCT ON (c."ownerId", (o.value->>'id')::bigint)
       c."ownerId" AS account_id, (o.value->>'id')::bigint AS order_id, o.value AS doc
FROM "ApiCache" c, jsonb_array_elements(c."value"->'orders') AS o(value)
WHERE c."key" LIKE 'orders:%'
ORDER BY c."ownerId", (o.value->>'id')::bigint, c."updatedAt" DESC;

INSERT INTO "OrderPeriod" ("accountId", "marketplace", "month", "isFinal", "orderCount", "fetchedAt")
SELECT c."ownerId", 'mercadolibre'::"Marketplace", substr(c."key", 8), COALESCE((c."value"->>'final')::boolean, false),
       jsonb_array_length(c."value"->'orders'), c."updatedAt" AT TIME ZONE 'UTC'
FROM "ApiCache" c
WHERE c."key" LIKE 'orders:%';

-- Parents first: listings and shipments referenced by orders (stubs, filled in below).
-- Item ids are upper-cased everywhere (compactOrder does it for new data).
INSERT INTO "Listing" ("accountId", "marketplace", "itemId")
SELECT account_id, 'mercadolibre'::"Marketplace", upper(it->>'itemId') FROM _legacy_orders, jsonb_array_elements(doc->'items') it
UNION SELECT "ownerId", 'mercadolibre'::"Marketplace", upper(substr("key", 9)) FROM "ApiCache" WHERE "key" LIKE 'catalog:%'
UNION SELECT "ownerId", 'mercadolibre'::"Marketplace", upper(substr("key", 6)) FROM "ApiCache" WHERE "key" LIKE 'gtin:%'
ON CONFLICT DO NOTHING;

INSERT INTO "Shipment" ("accountId", "marketplace", "shippingId")
SELECT account_id, 'mercadolibre'::"Marketplace", (doc->>'shippingId')::bigint FROM _legacy_orders WHERE jsonb_typeof(doc->'shippingId') = 'number'
UNION SELECT "ownerId", 'mercadolibre'::"Marketplace", substr("key", 7)::bigint FROM "ApiCache" WHERE "key" LIKE 'ship3:%'
ON CONFLICT DO NOTHING;

INSERT INTO "Payment" ("accountId", "marketplace", "paymentId")
SELECT account_id, 'mercadolibre'::"Marketplace", (p->>'id')::bigint FROM _legacy_orders, jsonb_array_elements(doc->'payments') p
UNION SELECT "ownerId", 'mercadolibre'::"Marketplace", substr("key", 5)::bigint FROM "ApiCache" WHERE "key" LIKE 'tax:%'
ON CONFLICT DO NOTHING;

INSERT INTO "Order" ("accountId", "marketplace", "orderId", "packId", "status", "createdAt", "shippingId")
SELECT account_id, 'mercadolibre'::"Marketplace", order_id, (doc->>'packId')::bigint, doc->>'status', (doc->>'dateCreated')::timestamptz,
       (doc->>'shippingId')::bigint
FROM _legacy_orders;

INSERT INTO "OrderItem" ("accountId", "marketplace", "orderId", "lineNo", "itemId", "title", "sellerSku", "sellerCustomField",
                         "variationId", "quantity", "unitPrice", "saleFee")
SELECT o.account_id, 'mercadolibre'::"Marketplace", o.order_id, (it.ord - 1)::int, upper(it.value->>'itemId'), it.value->>'title',
       it.value->>'sellerSku', it.value->>'sellerCustomField', (it.value->>'variationId')::bigint,
       round((it.value->>'quantity')::numeric)::int, (it.value->>'unitPrice')::numeric, (it.value->>'saleFee')::numeric
FROM _legacy_orders o, jsonb_array_elements(o.doc->'items') WITH ORDINALITY AS it(value, ord);

INSERT INTO "OrderPayment" ("accountId", "marketplace", "orderId", "paymentId", "status")
SELECT o.account_id, 'mercadolibre'::"Marketplace", o.order_id, (p->>'id')::bigint, (array_agg(p->>'status'))[1]
FROM _legacy_orders o, jsonb_array_elements(o.doc->'payments') p
GROUP BY o.account_id, o.order_id, (p->>'id')::bigint;

-- ─── 6. `ship3:<shippingId>` -> Shipment.sellerCost ──────────────────────────
-- (`ship:<id>` is the superseded v1 key, no code reads it any more: intentionally not migrated.)
UPDATE "Shipment" s
SET "sellerCost" = (c."value" #>> '{}')::numeric, "costFetchedAt" = c."updatedAt" AT TIME ZONE 'UTC'
FROM "ApiCache" c
WHERE c."key" LIKE 'ship3:%' AND jsonb_typeof(c."value") = 'number'
  AND c."ownerId" = s."accountId" AND substr(c."key", 7)::bigint = s."shippingId";

-- ─── 7. `tax:<paymentId>` -> Payment.tax* + PaymentTax ───────────────────────
-- JSON null = "asked, Mercado Pago has no detail" (taxFetchedAt set, taxTotal null).
-- Entries cached before the financing split have no `financing`: they keep their total but get
-- financingFee NULL, which makes the next sync ask Mercado Pago again (same as before).
UPDATE "Payment" p
SET "taxFetchedAt" = c."updatedAt" AT TIME ZONE 'UTC',
    "taxTotal"     = CASE WHEN jsonb_typeof(c."value") = 'object' THEN (c."value"->>'total')::numeric END,
    "financingFee" = CASE WHEN jsonb_typeof(c."value") = 'object' THEN (c."value"->>'financing')::numeric END
FROM "ApiCache" c
WHERE c."key" LIKE 'tax:%' AND c."ownerId" = p."accountId" AND substr(c."key", 5)::bigint = p."paymentId";

INSERT INTO "PaymentTax" ("accountId", "marketplace", "paymentId", "name", "amount")
SELECT c."ownerId", 'mercadolibre'::"Marketplace", substr(c."key", 5)::bigint, d.key, d.value::numeric
FROM "ApiCache" c, jsonb_each_text(c."value"->'det') d
WHERE c."key" LIKE 'tax:%' AND jsonb_typeof(c."value") = 'object' AND jsonb_typeof(c."value"->'det') = 'object';

-- ─── 8. `gtin:<itemId>` and `catalog:<itemId>` -> Listing / ListingVariation ─
UPDATE "Listing" l
SET "gtin" = NULLIF(g."value"->>'_item', ''), "gtinCheckedAt" = g."updatedAt" AT TIME ZONE 'UTC'
FROM "ApiCache" g
WHERE g."key" LIKE 'gtin:%' AND g."ownerId" = l."accountId" AND upper(substr(g."key", 6)) = l."itemId";

INSERT INTO "ListingVariation" ("accountId", "marketplace", "itemId", "variationId", "gtin")
SELECT g."ownerId", 'mercadolibre'::"Marketplace", upper(substr(g."key", 6)), v.key::bigint, v.value
FROM "ApiCache" g, jsonb_each_text(g."value") v
WHERE g."key" LIKE 'gtin:%' AND v.key ~ '^\d+$' AND v.value <> ''
ON CONFLICT DO NOTHING;

UPDATE "Listing" l
SET "title"            = c."value"->>'title',
    "catalogProductId" = c."value"->>'catalogProductId',
    "catalogCheckedAt" = CASE WHEN c."value" ? 'catalogProductId' THEN c."updatedAt" AT TIME ZONE 'UTC' END,
    "matchedEan"       = NULLIF(c."value"->>'ean', ''),
    "searchText"       = pg_temp.norm_text(concat_ws(' ', c."value"->>'title', c."value"->>'desc'))
FROM "ApiCache" c
WHERE c."key" LIKE 'catalog:%' AND c."ownerId" = l."accountId" AND upper(substr(c."key", 9)) = l."itemId";

-- Listings that legacy only knew through a search (no title in the cache entry) take the title of
-- their most recent sale: closed months are never downloaded again, so nothing else would fill it.
UPDATE "Listing" l
SET "title" = x."title",
    "searchText" = CASE WHEN l."searchText" = '' THEN pg_temp.norm_text(x."title") ELSE l."searchText" END
FROM (
  SELECT DISTINCT ON (i."accountId", i."marketplace", i."itemId") i."accountId", i."marketplace", i."itemId", i."title"
  FROM "OrderItem" i
  JOIN "Order" o ON o."accountId" = i."accountId" AND o."marketplace" = i."marketplace" AND o."orderId" = i."orderId"
  ORDER BY i."accountId", i."marketplace", i."itemId", o."createdAt" DESC
) x
WHERE l."title" IS NULL AND l."accountId" = x."accountId" AND l."marketplace" = x."marketplace" AND l."itemId" = x."itemId";

-- ─── 9. `seller:<id>` -> Seller (global: one row per seller, newest nickname wins) ─
INSERT INTO "Seller" ("marketplace", "sellerId", "nickname", "fetchedAt")
SELECT DISTINCT ON (substr("key", 8)::bigint) 'mercadolibre'::"Marketplace", substr("key", 8)::bigint, "value" #>> '{}', "updatedAt" AT TIME ZONE 'UTC'
FROM "ApiCache"
WHERE "key" LIKE 'seller:%' AND jsonb_typeof("value") = 'string'
ORDER BY substr("key", 8)::bigint, "updatedAt" DESC;

-- ─── 10. MarketResearch (one JSON per product) -> MarketScan + MarketOffer ───
INSERT INTO "MarketScan" ("accountId", "marketplace", "catalogProductId", "catalogTitle", "fetchedAt", "regression")
SELECT "ownerId", 'mercadolibre'::"Marketplace", "catalogProductId", COALESCE("payload"->>'catalogTitle', "catalogProductId"),
       "fetchedAt" AT TIME ZONE 'UTC', COALESCE("payload"->'regression', '{}'::jsonb)
FROM "MarketResearch";

-- kept points first (position 0..n-1), then excluded ones (position n..), preserving array order
INSERT INTO "MarketOffer" ("scanId", "position", "itemId", "sellerId", "title", "price", "soldQuantity",
                           "soldExact", "isOurs", "permalink", "excluded")
SELECT s."id", (pt.ord - 1)::int, pt.value->>'itemId', (pt.value->>'sellerId')::bigint,
       NULLIF(pt.value->>'title', r."payload"->>'catalogTitle'), (pt.value->>'price')::numeric,
       round((pt.value->>'soldQuantity')::numeric)::int, (pt.value->>'soldExact')::boolean,
       (pt.value->>'isOurs')::boolean,
       NULLIF(pt.value->>'permalink', 'https://articulo.mercadolibre.com.ar/'
              || regexp_replace(pt.value->>'itemId', '^([A-Z]{3})(\d+)$', '\1-\2')),
       NULL
FROM "MarketResearch" r
JOIN "MarketScan" s ON s."accountId" = r."ownerId" AND s."catalogProductId" = r."catalogProductId",
     jsonb_array_elements(r."payload"->'points') WITH ORDINALITY AS pt(value, ord)
UNION ALL
SELECT s."id", (jsonb_array_length(r."payload"->'points') + ex.ord - 1)::int, ex.value#>>'{point,itemId}',
       (ex.value#>>'{point,sellerId}')::bigint,
       NULLIF(ex.value#>>'{point,title}', r."payload"->>'catalogTitle'), (ex.value#>>'{point,price}')::numeric,
       round((ex.value#>>'{point,soldQuantity}')::numeric)::int, (ex.value#>>'{point,soldExact}')::boolean,
       (ex.value#>>'{point,isOurs}')::boolean,
       NULLIF(ex.value#>>'{point,permalink}', 'https://articulo.mercadolibre.com.ar/'
              || regexp_replace(ex.value#>>'{point,itemId}', '^([A-Z]{3})(\d+)$', '\1-\2')),
       (ex.value->>'reason')::"OfferExclusion"
FROM "MarketResearch" r
JOIN "MarketScan" s ON s."accountId" = r."ownerId" AND s."catalogProductId" = r."catalogProductId",
     jsonb_array_elements(COALESCE(r."payload"->'excluded', '[]'::jsonb)) WITH ORDINALITY AS ex(value, ord);

-- Snapshot and MatchDecision were altered in place (section 2): nothing to copy.
-- SaleLine is derived data: it is filled by the next sync / "Recalcular histórico" (see MIGRATION.md).

ANALYZE;

-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFICATION: abort (and roll everything back) if anything was lost or altered
-- ═════════════════════════════════════════════════════════════════════════════
CREATE FUNCTION pg_temp.assert_eq(what text, expected numeric, actual numeric) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF expected IS DISTINCT FROM actual THEN
    RAISE EXCEPTION 'normalize_schema backfill check failed for %: legacy=% new=%', what, expected, actual;
  END IF;
END $$;

DO $$
BEGIN
  PERFORM pg_temp.assert_eq('Account',
    (SELECT count(DISTINCT x."ownerId") FROM (
       SELECT "ownerId" FROM "MlToken" UNION ALL SELECT "ownerId" FROM "ApiCache" UNION ALL
       SELECT "ownerId" FROM "UserWorkbook" UNION ALL SELECT "ownerId" FROM "MarketResearch" UNION ALL
       SELECT "accountId" FROM "Snapshot" UNION ALL SELECT "accountId" FROM "MatchDecision") x),
    (SELECT count(*) FROM "Account"));
  PERFORM pg_temp.assert_eq('MarketplaceConnection', (SELECT count(*) FROM "MlToken"), (SELECT count(*) FROM "MarketplaceConnection"));
  PERFORM pg_temp.assert_eq('MarketplaceConnection ids', (SELECT COALESCE(sum("userId"), 0) FROM "MlToken"), (SELECT COALESCE(sum("externalUserId"::numeric), 0) FROM "MarketplaceConnection"));
  PERFORM pg_temp.assert_eq('Upload', (SELECT count(*) FROM "UserWorkbook"), (SELECT count(*) FROM "Upload"));
  PERFORM pg_temp.assert_eq('Product',
    (SELECT COALESCE(sum((SELECT count(*) FROM jsonb_object_keys("payload"->'base'))), 0) FROM "UserWorkbook" WHERE "kind" = 'pnl'),
    (SELECT count(*) FROM "Product"));
  PERFORM pg_temp.assert_eq('PnlClosing', (SELECT count(*) FROM "UserWorkbook" WHERE "kind" = 'pnl' AND "payload" ? 'prev'), (SELECT count(*) FROM "PnlClosing"));
  PERFORM pg_temp.assert_eq('CostOverride',
    (SELECT COALESCE(sum((SELECT count(*) FROM jsonb_object_keys("payload"->'override'))), 0) FROM "UserWorkbook" WHERE "kind" = 'inputs'),
    (SELECT count(*) FROM "CostOverride"));
  PERFORM pg_temp.assert_eq('ProductMapping',
    (SELECT COALESCE(sum((SELECT count(*) FROM jsonb_object_keys("payload"->'mapItem')) + (SELECT count(*) FROM jsonb_object_keys("payload"->'mapSku'))), 0)
       FROM "UserWorkbook" WHERE "kind" = 'inputs'),
    (SELECT count(*) FROM "ProductMapping"));
  PERFORM pg_temp.assert_eq('DirectSale',
    (SELECT COALESCE(sum(jsonb_array_length("payload"->'va')), 0) FROM "UserWorkbook" WHERE "kind" = 'inputs'),
    (SELECT count(*) FROM "DirectSale"));
  PERFORM pg_temp.assert_eq('StockReceipt',
    (SELECT COALESCE(sum(jsonb_array_length("payload"->'ingresos')), 0) FROM "UserWorkbook" WHERE "kind" = 'inputs'),
    (SELECT count(*) FROM "StockReceipt"));

  PERFORM pg_temp.assert_eq('Order', (SELECT count(*) FROM _legacy_orders), (SELECT count(*) FROM "Order"));
  PERFORM pg_temp.assert_eq('OrderPeriod', (SELECT count(*) FROM "ApiCache" WHERE "key" LIKE 'orders:%'), (SELECT count(*) FROM "OrderPeriod"));
  PERFORM pg_temp.assert_eq('OrderItem count',
    (SELECT COALESCE(sum(jsonb_array_length(doc->'items')), 0) FROM _legacy_orders), (SELECT count(*) FROM "OrderItem"));
  PERFORM pg_temp.assert_eq('OrderItem revenue',
    (SELECT COALESCE(sum((it->>'unitPrice')::numeric * (it->>'quantity')::numeric), 0) FROM _legacy_orders, jsonb_array_elements(doc->'items') it),
    (SELECT COALESCE(sum("unitPrice" * "quantity"), 0) FROM "OrderItem"));
  PERFORM pg_temp.assert_eq('OrderItem fees',
    (SELECT COALESCE(sum((it->>'saleFee')::numeric), 0) FROM _legacy_orders, jsonb_array_elements(doc->'items') it),
    (SELECT COALESCE(sum("saleFee"), 0) FROM "OrderItem"));
  PERFORM pg_temp.assert_eq('OrderPayment',
    (SELECT count(*) FROM (SELECT DISTINCT account_id, order_id, p->>'id' FROM _legacy_orders, jsonb_array_elements(doc->'payments') p) x),
    (SELECT count(*) FROM "OrderPayment"));

  PERFORM pg_temp.assert_eq('Shipment cost rows',
    (SELECT count(*) FROM "ApiCache" WHERE "key" LIKE 'ship3:%' AND jsonb_typeof("value") = 'number'),
    (SELECT count(*) FROM "Shipment" WHERE "costFetchedAt" IS NOT NULL));
  PERFORM pg_temp.assert_eq('Shipment cost total',
    (SELECT COALESCE(sum(("value" #>> '{}')::numeric), 0) FROM "ApiCache" WHERE "key" LIKE 'ship3:%' AND jsonb_typeof("value") = 'number'),
    (SELECT COALESCE(sum("sellerCost"), 0) FROM "Shipment"));
  PERFORM pg_temp.assert_eq('Payment tax rows',
    (SELECT count(*) FROM "ApiCache" WHERE "key" LIKE 'tax:%'), (SELECT count(*) FROM "Payment" WHERE "taxFetchedAt" IS NOT NULL));
  PERFORM pg_temp.assert_eq('Payment tax total',
    (SELECT COALESCE(sum(("value"->>'total')::numeric), 0) FROM "ApiCache" WHERE "key" LIKE 'tax:%' AND jsonb_typeof("value") = 'object'),
    (SELECT COALESCE(sum("taxTotal"), 0) FROM "Payment"));
  PERFORM pg_temp.assert_eq('PaymentTax detail lines',
    (SELECT COALESCE(sum((SELECT count(*) FROM jsonb_object_keys("value"->'det'))), 0) FROM "ApiCache" WHERE "key" LIKE 'tax:%' AND jsonb_typeof("value") = 'object'),
    (SELECT count(*) FROM "PaymentTax"));
  PERFORM pg_temp.assert_eq('PaymentTax detail total',
    (SELECT COALESCE(sum(d.value::numeric), 0) FROM "ApiCache" c, jsonb_each_text(c."value"->'det') d WHERE c."key" LIKE 'tax:%' AND jsonb_typeof(c."value") = 'object'),
    (SELECT COALESCE(sum("amount"), 0) FROM "PaymentTax"));

  PERFORM pg_temp.assert_eq('Listing gtin rows',
    (SELECT count(*) FROM "ApiCache" WHERE "key" LIKE 'gtin:%'), (SELECT count(*) FROM "Listing" WHERE "gtinCheckedAt" IS NOT NULL));
  PERFORM pg_temp.assert_eq('Listing gtin values',
    (SELECT count(*) FROM "ApiCache" WHERE "key" LIKE 'gtin:%' AND COALESCE("value"->>'_item', '') <> ''),
    (SELECT count(*) FROM "Listing" WHERE "gtin" IS NOT NULL));
  PERFORM pg_temp.assert_eq('ListingVariation',
    (SELECT count(*) FROM "ApiCache" g, jsonb_each_text(g."value") v WHERE g."key" LIKE 'gtin:%' AND v.key ~ '^\d+$' AND v.value <> ''),
    (SELECT count(*) FROM "ListingVariation"));
  PERFORM pg_temp.assert_eq('Listing catalog rows',
    (SELECT count(*) FROM "ApiCache" WHERE "key" LIKE 'catalog:%' AND "value" ? 'catalogProductId'),
    (SELECT count(*) FROM "Listing" WHERE "catalogCheckedAt" IS NOT NULL));
  PERFORM pg_temp.assert_eq('Listing catalog ids',
    (SELECT count(*) FROM "ApiCache" WHERE "key" LIKE 'catalog:%' AND COALESCE("value"->>'catalogProductId', '') <> ''),
    (SELECT count(*) FROM "Listing" WHERE "catalogProductId" IS NOT NULL));
  PERFORM pg_temp.assert_eq('Listing matched EANs',
    (SELECT count(*) FROM "ApiCache" WHERE "key" LIKE 'catalog:%' AND COALESCE("value"->>'ean', '') <> ''),
    (SELECT count(*) FROM "Listing" WHERE "matchedEan" IS NOT NULL));
  PERFORM pg_temp.assert_eq('Seller',
    (SELECT count(DISTINCT substr("key", 8)) FROM "ApiCache" WHERE "key" LIKE 'seller:%' AND jsonb_typeof("value") = 'string'),
    (SELECT count(*) FROM "Seller"));

  PERFORM pg_temp.assert_eq('MarketScan', (SELECT count(*) FROM "MarketResearch"), (SELECT count(*) FROM "MarketScan"));
  PERFORM pg_temp.assert_eq('MarketOffer',
    (SELECT COALESCE(sum(jsonb_array_length("payload"->'points') + jsonb_array_length(COALESCE("payload"->'excluded', '[]'::jsonb))), 0) FROM "MarketResearch"),
    (SELECT count(*) FROM "MarketOffer"));
  PERFORM pg_temp.assert_eq('MarketOffer prices',
    (SELECT COALESCE(sum((p.value->>'price')::numeric), 0) FROM "MarketResearch" r, jsonb_array_elements(r."payload"->'points') p)
      + (SELECT COALESCE(sum((e.value#>>'{point,price}')::numeric), 0) FROM "MarketResearch" r, jsonb_array_elements(COALESCE(r."payload"->'excluded', '[]'::jsonb)) e),
    (SELECT COALESCE(sum("price"), 0) FROM "MarketOffer"));
END $$;

DROP TABLE _legacy_orders;

-- every migrated marketplace row is Mercado Libre
DO $$
BEGIN
  PERFORM pg_temp.assert_eq('non-ML marketplace rows',
    0, (SELECT count(*) FROM "Order" WHERE marketplace <> 'mercadolibre') + (SELECT count(*) FROM "Listing" WHERE marketplace <> 'mercadolibre')
      + (SELECT count(*) FROM "Payment" WHERE marketplace <> 'mercadolibre') + (SELECT count(*) FROM "Shipment" WHERE marketplace <> 'mercadolibre')
      + (SELECT count(*) FROM "MatchDecision" WHERE marketplace <> 'mercadolibre'));
END $$;
