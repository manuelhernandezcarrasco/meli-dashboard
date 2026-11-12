-- CONTRACT step of the normalize_schema migration (docs/database/MIGRATION.md, "Contract step").
--
-- Drops the four legacy JSON-store tables. Their data lives on in Account, MarketplaceConnection, Upload,
-- Product, PnlClosing, CostOverride, ProductMapping, DirectSale, StockReceipt, Listing, ListingVariation,
-- Seller, Shipment, Order, OrderItem, Payment, PaymentTax, OrderPayment, OrderPeriod, MarketScan,
-- MarketOffer and CompetitorSale (the `sold:` rows of ApiCache, copied by 20261112175811_competitor_sale).
-- Nothing in src/ reads them (a test enforces it) and no foreign key points at them.
--
-- DROP TABLE is irreversible: take a backup first (`pg_dump -Fc`). Disk space is returned to the
-- operating system immediately, because each table owns its own files (no VACUUM FULL needed).
-- IF EXISTS keeps the file re-runnable.

DROP TABLE IF EXISTS "MlToken";
DROP TABLE IF EXISTS "ApiCache";
DROP TABLE IF EXISTS "UserWorkbook";
DROP TABLE IF EXISTS "MarketResearch";
