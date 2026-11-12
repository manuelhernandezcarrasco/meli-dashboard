-- Expectations on the fixture after migration 20261112000000_normalize_schema. Any failure aborts.
-- (The migration also runs its own count/sum checks against the legacy tables.)
DO $$
DECLARE n bigint;
BEGIN
  ASSERT (SELECT count(*) FROM "Account") = 2, 'accounts: u_a and u_b';
  ASSERT (SELECT "externalUserId" FROM "MarketplaceConnection" WHERE "accountId" = 'u_a' AND marketplace = 'mercadolibre') = '424242', 'token moved, tagged Mercado Libre';
  ASSERT (SELECT count(*) FROM "Order" WHERE marketplace <> 'mercadolibre') + (SELECT count(*) FROM "Listing" WHERE marketplace <> 'mercadolibre')
       + (SELECT count(*) FROM "Payment" WHERE marketplace <> 'mercadolibre') + (SELECT count(*) FROM "Seller" WHERE marketplace <> 'mercadolibre')
       + (SELECT count(*) FROM "ProductMapping" WHERE marketplace <> 'mercadolibre') + (SELECT count(*) FROM "MatchDecision" WHERE marketplace <> 'mercadolibre') = 0, 'every legacy row is Mercado Libre';

  -- orders: 2002 appears in two blobs, the newer one wins; ids, instants, lines and payments intact
  ASSERT (SELECT count(*) FROM "Order") = 5, 'orders deduplicated';
  ASSERT (SELECT status FROM "Order" WHERE "orderId" = 2002) = 'cancelled', 'newest blob wins';
  ASSERT (SELECT "createdAt" FROM "Order" WHERE "orderId" = 2002) = '2026-09-15T13:30:00.123Z'::timestamptz, 'instant kept to the ms';
  ASSERT (SELECT "packId" FROM "Order" WHERE "orderId" = 2002) = 777 AND (SELECT "packId" FROM "Order" WHERE "orderId" = 2001) IS NULL, 'pack ids';
  ASSERT (SELECT "shippingId" FROM "Order" WHERE "orderId" = 2003) IS NULL, 'no shipment kept as null';
  ASSERT (SELECT count(*) FROM "OrderItem" WHERE "orderId" = 2002) = 1, 'newest blob has one line for 2002';
  ASSERT (SELECT "itemId" FROM "OrderItem" WHERE "orderId" = 2003) = 'MLA2', 'item ids upper-cased';
  ASSERT (SELECT "variationId" FROM "OrderItem" WHERE "orderId" = 2002) = 55, 'variation';
  ASSERT (SELECT count(*) FROM "OrderPayment" WHERE "paymentId" = 901) = 2, 'one payment shared by two orders';
  ASSERT (SELECT count(*) FROM "OrderPeriod") = 2 AND (SELECT "isFinal" FROM "OrderPeriod" WHERE month = '2026-09') AND NOT (SELECT "isFinal" FROM "OrderPeriod" WHERE month = '2026-10'), 'period state';

  -- shipping: v3 keys only, stubs for shipments without a cost
  ASSERT (SELECT "sellerCost" FROM "Shipment" WHERE "shippingId" = 111) = 1500.5, 'cost of 111 comes from ship3, not the v1 key';
  ASSERT (SELECT "sellerCost" FROM "Shipment" WHERE "shippingId" = 112) = -42.25, 'negative (credited) cost';
  ASSERT (SELECT "costFetchedAt" FROM "Shipment" WHERE "shippingId" = 113) IS NULL, 'never-asked shipment is a stub';
  ASSERT (SELECT "sellerCost" FROM "Shipment" WHERE "shippingId" = 999) = 7, 'cost of a shipment without stored orders';

  -- taxes
  ASSERT (SELECT "taxTotal" FROM "Payment" WHERE "paymentId" = 901) = 30 AND (SELECT "financingFee" FROM "Payment" WHERE "paymentId" = 901) = 5.5, 'full entry';
  ASSERT (SELECT count(*) FROM "PaymentTax" WHERE "paymentId" = 901) = 2, 'detail lines';
  ASSERT (SELECT "taxFetchedAt" IS NOT NULL AND "taxTotal" IS NULL FROM "Payment" WHERE "paymentId" = 902), 'no detail = asked + null';
  ASSERT (SELECT "taxTotal" = 12.5 AND "financingFee" IS NULL FROM "Payment" WHERE "paymentId" = 903), 'pre-split entry keeps its total, financing null (asked again once)';
  ASSERT (SELECT "taxFetchedAt" IS NULL FROM "Payment" WHERE "paymentId" = 905), 'payment never asked';
  ASSERT (SELECT count(*) FROM "Payment" WHERE "paymentId" = 904) = 1, 'orphan payment kept';

  -- listings
  ASSERT (SELECT gtin FROM "Listing" WHERE "itemId" = 'MLA1') = '7790001', 'item gtin';
  ASSERT (SELECT count(*) FROM "ListingVariation") = 1 AND (SELECT gtin FROM "ListingVariation" WHERE "variationId" = 55) = '7790055', 'variation gtin, empty one skipped';
  ASSERT (SELECT gtin IS NULL AND "gtinCheckedAt" IS NOT NULL FROM "Listing" WHERE "itemId" = 'MLA2'), 'asked, no gtin';
  ASSERT (SELECT "catalogProductId" FROM "Listing" WHERE "itemId" = 'MLA1') = 'MLA-C1', 'catalog id';
  ASSERT (SELECT "catalogProductId" IS NULL AND "catalogCheckedAt" IS NOT NULL FROM "Listing" WHERE "itemId" = 'MLA2'), 'asked, no catalog product';
  ASSERT (SELECT "matchedEan" FROM "Listing" WHERE "itemId" = 'MLA1') = '7790001' AND (SELECT "matchedEan" FROM "Listing" WHERE "itemId" = 'MLA2') IS NULL, 'matched ean';
  ASSERT (SELECT "searchText" FROM "Listing" WHERE "itemId" = 'MLA1') = 'camara sony camara reflex', 'search text lower-cased, accents stripped';
  ASSERT (SELECT title IS NULL AND "catalogProductId" = 'MLA-C8' FROM "Listing" WHERE "itemId" = 'MLA8' AND "accountId" = 'u_a'), 'search-only entry never sold: stays without title';
  ASSERT (SELECT title = 'Solo búsqueda' AND "searchText" = 'solo busqueda' AND "catalogProductId" = 'MLA-C9' FROM "Listing" WHERE "itemId" = 'MLA9' AND "accountId" = 'u_a'), 'search-only entry that was sold takes the title of its latest sale';
  ASSERT (SELECT count(*) FROM "Seller") = 2 AND (SELECT nickname FROM "Seller" WHERE "sellerId" = 5) = 'uno bis', 'sellers global, newest nickname wins';

  -- master data
  ASSERT (SELECT count(*) FROM "Upload") = 2 AND (SELECT "rowCount" FROM "Upload" WHERE kind = 'pnl') = 2 AND (SELECT "rowCount" FROM "Upload" WHERE kind = 'inputs') = 2, 'uploads';
  ASSERT (SELECT ean FROM "Product" ORDER BY position LIMIT 1) = '779', 'position keeps the legacy (jsonb) order: shorter key first';
  ASSERT (SELECT "unitCost" FROM "Product" WHERE ean = '7790001') = 1000.123456, 'floats are exact';
  ASSERT (SELECT "prevMlCostPct" IS NULL FROM "Product" WHERE ean = '779'), 'null stays null';
  ASSERT (SELECT "salesMl" = 100.5 AND "netIncome" = 90.5 FROM "PnlClosing"), 'previous close';
  ASSERT (SELECT count(*) FROM "DirectSale") = 2 AND (SELECT quantity FROM "DirectSale" WHERE customer = 'Beto') = 2.5, 'direct sales, fractional quantity';
  ASSERT (SELECT customer FROM "DirectSale" ORDER BY id LIMIT 1) = 'Ana', 'direct sales keep file order';
  ASSERT (SELECT count(*) FROM "ProductMapping") = 2 AND (SELECT count(*) FROM "ProductMapping" WHERE kind = 'item') = 1, 'mappings';
  ASSERT (SELECT "unitCost" = 5 AND category IS NULL FROM "CostOverride" WHERE ean = '7790003'), 'override';
  ASSERT (SELECT count(*) FROM "StockReceipt") = 1, 'stock receipts';
  ASSERT (SELECT count(*) FROM "MatchDecision" WHERE decision = 'confirmed') = 1 AND (SELECT count(*) FROM "MatchDecision" WHERE decision = 'rejected') = 1, 'typed decisions';
  ASSERT (SELECT count(*) FROM "Snapshot") = 2 AND (SELECT "computedAt" FROM "Snapshot" WHERE "accountId" = 'u_a') = '2026-10-20T12:00:00Z'::timestamptz, 'snapshots in place, instants preserved';

  -- market research
  ASSERT (SELECT count(*) FROM "MarketScan" WHERE marketplace = 'mercadolibre') = 1 AND (SELECT count(*) FROM "MarketOffer") = 3, 'scan and offers';
  ASSERT (SELECT excluded::text FROM "MarketOffer" WHERE position = 2) = 'price_outlier', 'excluded offers follow the kept ones';
  ASSERT (SELECT title IS NULL AND permalink IS NULL FROM "MarketOffer" WHERE position = 1), 'catalog title / canonical permalink are not stored twice';
  ASSERT (SELECT title = 'Nuestro título' FROM "MarketOffer" WHERE position = 0), 'own title kept';

  -- the legacy tables are untouched (dropped by a later migration)
  ASSERT (SELECT count(*) FROM "ApiCache") = 19 AND (SELECT count(*) FROM "UserWorkbook") = 2, 'legacy rows still there';

  -- account deletion removes everything of one tenant and nothing of the other
  DELETE FROM "Account" WHERE id = 'u_a';
  SELECT (SELECT count(*) FROM "Order") + (SELECT count(*) FROM "OrderItem") + (SELECT count(*) FROM "Listing") + (SELECT count(*) FROM "Payment")
       + (SELECT count(*) FROM "Shipment") + (SELECT count(*) FROM "Product") + (SELECT count(*) FROM "MarketOffer") INTO n;
  ASSERT n = 0, 'cascade removed every row of the deleted account';
  ASSERT (SELECT count(*) FROM "Snapshot") = 1, 'the other tenant is untouched';
END $$;
