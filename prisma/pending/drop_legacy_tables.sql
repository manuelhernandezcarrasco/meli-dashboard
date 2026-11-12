-- CONTRACT step of the normalize_schema migration. NOT applied by `prisma migrate deploy` while it lives
-- in this folder. Procedure and preconditions: docs/database/MIGRATION.md ("Contract step").
--
-- Only run after: a week on the new schema, a verified backup, and the four models below removed from
-- prisma/schema.prisma. Their data lives on in Account, MlConnection, Upload, Product, PnlClosing,
-- CostOverride, ProductMapping, DirectSale, StockReceipt, Listing, ListingVariation, Seller, Shipment,
-- Order, OrderItem, Payment, PaymentTax, OrderPayment, OrderPeriod, MarketScan and MarketOffer.

DROP TABLE "MlToken";
DROP TABLE "ApiCache";
DROP TABLE "UserWorkbook";
DROP TABLE "MarketResearch";
