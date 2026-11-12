-- Legacy-schema fixture for migration 20261112000000_normalize_schema.
-- Shapes are exactly what the old code wrote; the odd rows are the ones a long-lived database accumulates.
-- Run through scripts/test-migration.sh (which then applies the migration and normalize_schema.assert.sql).

INSERT INTO "MlToken" ("ownerId", "accessToken", "refreshToken", "userId", "expiresAt", "updatedAt")
VALUES ('u_a', 'TEST-access', 'TEST-refresh', 424242, '2026-11-12 00:00:00', '2026-11-01 10:00:00');

INSERT INTO "ApiCache" ("ownerId", "key", "value", "updatedAt") VALUES
-- September, final. o1 pays 901; o2 is a pack with 2 lines (one variation) and 2 payments; o3 is cancelled;
-- o4 shares payment 901 and shipment 111 with o1 (a pack paid once).
('u_a', 'orders:2026-09', '{"final": true, "orders": [
  {"id": 2001, "packId": null, "status": "paid", "dateCreated": "2026-09-01T00:00:00.000-03:00", "shippingId": 111,
   "items": [{"itemId": "MLA1", "title": "Cámara Sony", "sellerSku": "", "sellerCustomField": null, "variationId": null, "quantity": 2, "unitPrice": 1500.5, "saleFee": 210.25}],
   "payments": [{"id": 901, "status": "approved"}]},
  {"id": 2002, "packId": 777, "status": "paid", "dateCreated": "2026-09-15T10:30:00.123-03:00", "shippingId": 112,
   "items": [{"itemId": "MLA1", "title": "Cámara Sony", "sellerSku": "S1", "sellerCustomField": "cf", "variationId": 55, "quantity": 1, "unitPrice": 10, "saleFee": 1},
             {"itemId": "mla2", "title": "Trípode", "sellerSku": null, "sellerCustomField": null, "variationId": null, "quantity": 3, "unitPrice": 99.99, "saleFee": 9.5}],
   "payments": [{"id": 902, "status": "approved"}, {"id": 903, "status": "refunded"}]},
  {"id": 2003, "packId": null, "status": "cancelled", "dateCreated": "2026-09-30T23:59:59.999-03:00", "shippingId": null,
   "items": [{"itemId": "MLA2", "title": "Trípode", "sellerSku": null, "sellerCustomField": null, "variationId": null, "quantity": 1, "unitPrice": 99.99, "saleFee": 9.5}],
   "payments": []},
  {"id": 2004, "packId": 777, "status": "paid", "dateCreated": "2026-09-15T10:31:00.000-03:00", "shippingId": 111,
   "items": [{"itemId": "MLA1", "title": "Cámara Sony", "sellerSku": "", "sellerCustomField": null, "variationId": null, "quantity": 1, "unitPrice": 1500.5, "saleFee": 210.25}],
   "payments": [{"id": 901, "status": "approved"}]}
]}', '2026-10-08 10:00:00'),
-- October closed month stored early (days 1-5 rule): not final, and it repeats order 2002 with a newer state
('u_a', 'orders:2026-10', '{"final": false, "orders": [
  {"id": 2002, "packId": 777, "status": "cancelled", "dateCreated": "2026-09-15T10:30:00.123-03:00", "shippingId": 112,
   "items": [{"itemId": "MLA1", "title": "Cámara Sony", "sellerSku": "S1", "sellerCustomField": "cf", "variationId": 55, "quantity": 1, "unitPrice": 10, "saleFee": 1}],
   "payments": [{"id": 902, "status": "approved"}]},
  {"id": 2005, "packId": null, "status": "paid", "dateCreated": "2026-10-02T09:00:00.000-03:00", "shippingId": 113,
   "items": [{"itemId": "MLA9", "title": "Solo búsqueda", "sellerSku": null, "sellerCustomField": null, "variationId": null, "quantity": 1, "unitPrice": 50, "saleFee": 5}],
   "payments": [{"id": 905, "status": "approved"}]}
]}', '2026-10-09 10:00:00'),
-- shipping: v3 keys are migrated, the v1 `ship:` key is not, 999 belongs to an order that is not stored
('u_a', 'ship3:111', '1500.5', '2026-10-08 10:00:00'),
('u_a', 'ship3:112', '-42.25', '2026-10-08 10:00:00'),
('u_a', 'ship3:999', '7', '2026-10-08 10:00:00'),
('u_a', 'ship:111', '99', '2026-09-01 10:00:00'),
-- taxes: full, "no detail" (JSON null), cached before the financing split, and an orphan payment
('u_a', 'tax:901', '{"total": 30, "det": {"IVA": 10, "IIBB CABA": 20}, "financing": 5.5}', '2026-10-08 10:00:00'),
('u_a', 'tax:902', 'null', '2026-10-08 10:00:00'),
('u_a', 'tax:903', '{"total": 12.5, "det": {"IVA": 12.5}}', '2026-10-08 10:00:00'),
('u_a', 'tax:904', '{"total": 1, "det": {}, "financing": 0}', '2026-10-08 10:00:00'),
-- GTINs: item + variations (an empty variation GTIN is skipped), and "asked, none"
('u_a', 'gtin:MLA1', '{"_item": "7790001", "55": "7790055", "99": ""}', '2026-10-08 10:00:00'),
('u_a', 'gtin:MLA2', '{"_item": ""}', '2026-10-08 10:00:00'),
-- catalog entries: matched with catalog id, unmatched without, and a search-only one (no title)
('u_a', 'catalog:MLA1', '{"catalogProductId": "MLA-C1", "title": "Cámara Sony", "ean": "7790001", "desc": "Cámara Réflex"}', '2026-10-08 10:00:00'),
('u_a', 'catalog:MLA2', '{"catalogProductId": null, "title": "Trípode", "ean": "", "desc": ""}', '2026-10-08 10:00:00'),
('u_a', 'catalog:MLA9', '{"catalogProductId": "MLA-C9"}', '2026-10-08 10:00:00'),
('u_a', 'catalog:MLA8', '{"catalogProductId": "MLA-C8"}', '2026-10-08 10:00:00'),
-- the same public seller cached by two tenants
('u_a', 'seller:5', '"uno"', '2026-10-01 10:00:00'),
('u_b', 'seller:5', '"uno bis"', '2026-10-02 10:00:00'),
('u_a', 'seller:6', '"seis"', '2026-10-01 10:00:00');

INSERT INTO "Snapshot" ("ownerId", "month", "payload", "computedAt") VALUES
('u_a', '2026-10', '{"rows": []}', '2026-10-20 12:00:00'),
('u_b', '2026-10', '{"rows": []}', '2026-10-20 12:00:00');

INSERT INTO "MatchDecision" ("ownerId", "itemId", "ean", "decision", "decidedAt") VALUES
('u_a', 'MLA1', '7790001', 'confirmed', '2026-10-10 10:00:00'),
('u_a', 'MLA2', '7790002', 'rejected', '2026-10-11 10:00:00');

INSERT INTO "UserWorkbook" ("ownerId", "kind", "fileName", "payload", "uploadedAt") VALUES
('u_a', 'pnl', 'cierre.xlsx', '{
  "base": {
    "7790001": {"ean": "7790001", "desc": "Cámara Réflex", "modelo": "A7", "cat": "SONY", "cu": 1000.123456, "stock": 10, "mg": 0.3, "costoMlPctPrev": 0.21, "udsPrev": 5},
    "779": {"ean": "779", "desc": "Producto corto", "modelo": "", "cat": "OTRAS", "cu": 0, "stock": 0, "mg": 0.25, "costoMlPctPrev": null, "udsPrev": 0}
  },
  "prev": {"ventaMl": 100.5, "ventaVa": 20, "venta": 120.5, "costoMl": 30, "cogs": 60, "uds": 7, "ingNetos": 90.5, "margen": 30.5}
}', '2026-10-05 10:00:00'),
('u_a', 'inputs', 'va.xlsx', '{
  "va": [{"date": "2026-10-03", "cliente": "Ana", "ean": "7790001", "desc": "Cámara", "qty": 1, "pu": 2000.5},
         {"date": "2026-10-04", "cliente": "Beto", "ean": "779", "desc": "Corto", "qty": 2.5, "pu": 10}],
  "mapItem": {"MLA1": "7790001"}, "mapSku": {"SKU9": "7790001"},
  "override": {"7790003": {"cu": 5, "desc": "Override", "cat": null}},
  "ingresos": [{"date": "2026-10-06", "ean": "7790001", "qty": 4}]
}', '2026-10-05 10:05:00');

INSERT INTO "MarketResearch" ("ownerId", "catalogProductId", "payload", "fetchedAt") VALUES
('u_a', 'MLA-C1', '{
  "catalogProductId": "MLA-C1", "catalogTitle": "Cámara X", "fetchedAt": "2026-11-10T12:00:00.000Z",
  "points": [
    {"itemId": "MLA101", "sellerId": 424242, "sellerNickname": "NOSOTROS", "title": "Nuestro título", "price": 1010, "soldQuantity": 12, "soldExact": true, "permalink": "https://articulo.mercadolibre.com.ar/MLA-101", "isOurs": true},
    {"itemId": "MLA102", "sellerId": 5002, "sellerNickname": "5002", "title": "Cámara X", "price": 1020, "soldQuantity": null, "soldExact": false, "permalink": "https://articulo.mercadolibre.com.ar/MLA-102", "isOurs": false}],
  "excluded": [
    {"point": {"itemId": "MLA103", "sellerId": 5003, "sellerNickname": "5003", "title": "Cámara X", "price": 99999, "soldQuantity": null, "soldExact": false, "permalink": "https://articulo.mercadolibre.com.ar/MLA-103", "isOurs": false}, "reason": "price_outlier"}],
  "regression": {"log": {"mode": "log", "slope": 1.5, "intercept": 2, "r2": 0.5, "n": 3}, "linear": null}
}', '2026-11-10 12:00:00');
