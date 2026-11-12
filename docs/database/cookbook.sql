-- Statistics cookbook: queries the normalized schema makes cheap. Every statement runs as is
-- (replace the :account / :month / :catalog values); docs/database/README.md explains when to use which table.
-- Money is ARS. Margin = revenue - marketplaceCost - cogs. `channel` is 'marketplace' or 'direct'; add
-- `AND marketplace = 'mercadolibre'` to look at one marketplace, or `GROUP BY marketplace` to compare them.

-- 1. Daily revenue and margin (trend line)
SELECT "saleDate", sum(revenue) AS revenue, sum(revenue - "marketplaceCost" - cogs) AS margin
FROM "SaleLine"
WHERE "accountId" = 'user_2legacyAAA' AND "saleDate" >= '2026-09-01'
GROUP BY 1 ORDER BY 1;

-- 2. Where the money goes, per category: marketplace fee, financing, shipping, taxes and product cost as % of revenue
SELECT category,
       round(sum(revenue))                                             AS revenue,
       round(100 * sum("saleFee")      / nullif(sum(revenue), 0), 1)  AS fee_pct,
       round(100 * sum("financingFee") / nullif(sum(revenue), 0), 1)  AS financing_pct,
       round(100 * sum("shippingCost") / nullif(sum(revenue), 0), 1)  AS shipping_pct,
       round(100 * sum("taxAmount")    / nullif(sum(revenue), 0), 1)  AS tax_pct,
       round(100 * sum(cogs)           / nullif(sum(revenue), 0), 1)  AS cogs_pct,
       round(100 * sum(revenue - "marketplaceCost" - cogs) / nullif(sum(revenue), 0), 1) AS margin_pct
FROM "SaleLine"
WHERE "accountId" = 'user_2legacyAAA' AND period = '2026-10' AND channel = 'marketplace'
GROUP BY 1 ORDER BY revenue DESC;

-- 3. Best and worst listings by absolute margin, with how reliable the product match is
SELECT "itemId", max("listingTitle") AS title, sum(quantity) AS units,
       round(sum(revenue - "marketplaceCost" - cogs)) AS margin,
       string_agg(DISTINCT "matchVia", ', ') AS matched_by, bool_or("costSource" LIKE 'Asumido%' OR "costSource" LIKE 'Sin match%') AS assumed_cost
FROM "SaleLine"
WHERE "accountId" = 'user_2legacyAAA' AND period = '2026-10' AND channel = 'marketplace'
GROUP BY 1 ORDER BY margin DESC LIMIT 10;

-- 4. Data quality: share of revenue that is unmatched or uses an assumed cost, per month
SELECT period,
       round(100 * sum(revenue) FILTER (WHERE category = 'SIN MATCH') / nullif(sum(revenue), 0), 1) AS unmatched_pct,
       round(100 * sum(revenue) FILTER (WHERE "costSource" NOT LIKE 'Real%' AND "costSource" <> 'Override') / nullif(sum(revenue), 0), 1) AS assumed_cost_pct
FROM "SaleLine" WHERE "accountId" = 'user_2legacyAAA' GROUP BY 1 ORDER BY 1;

-- 5. Orders by hour of day (Argentina time): when do customers buy?
SELECT extract(hour FROM "createdAt" AT TIME ZONE 'America/Argentina/Buenos_Aires')::int AS hour, count(*) AS orders
FROM "Order" WHERE "accountId" = 'user_2legacyAAA' AND status = 'paid' GROUP BY 1 ORDER BY 1;

-- 6. Real taxes by type for a month (a payment shared by several orders of a pack is counted once per link)
SELECT t."name", round(sum(t."amount")) AS amount
FROM "PaymentTax" t
JOIN "OrderPayment" op ON op."accountId" = t."accountId" AND op."paymentId" = t."paymentId"
JOIN "Order" o ON o."accountId" = op."accountId" AND o."orderId" = op."orderId"
WHERE t."accountId" = 'user_2legacyAAA' AND o."createdAt" >= '2026-10-01 03:00+00' AND o."createdAt" < '2026-11-01 03:00+00'
GROUP BY 1 ORDER BY 2 DESC;

-- 7. Shipping: average net cost per shipment by week (negative = Flex credit)
SELECT date_trunc('week', o."createdAt") AS week, round(avg(s."sellerCost"), 2) AS avg_cost, count(*) AS shipments
FROM "Order" o JOIN "Shipment" s ON s."accountId" = o."accountId" AND s."shippingId" = o."shippingId"
WHERE o."accountId" = 'user_2legacyAAA' AND s."sellerCost" IS NOT NULL GROUP BY 1 ORDER BY 1;

-- 8. Competitor price history for a catalog product: median / min / max of the offers kept in each scan
SELECT s."fetchedAt"::date AS day,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY o.price) AS median_price, min(o.price) AS min_price, max(o.price) AS max_price, count(*) AS offers
FROM "MarketScan" s JOIN "MarketOffer" o ON o."scanId" = s.id
WHERE s."accountId" = 'user_2legacyAAA' AND s."catalogProductId" = 'MLA-CAT-9' AND o.excluded IS NULL
GROUP BY 1 ORDER BY 1;

-- 9. Our price against the market in the latest scan of each catalog product we sell
SELECT DISTINCT ON (s."catalogProductId") s."catalogProductId", s."catalogTitle", s."fetchedAt",
       (SELECT min(price) FROM "MarketOffer" m WHERE m."scanId" = s.id AND m."isOurs") AS our_price,
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price) FROM "MarketOffer" m WHERE m."scanId" = s.id AND NOT m."isOurs" AND m.excluded IS NULL) AS market_median
FROM "MarketScan" s WHERE s."accountId" = 'user_2legacyAAA'
ORDER BY s."catalogProductId", s."fetchedAt" DESC;

-- 10. Which stored months are final, and how many orders each holds
SELECT month, "isFinal", "orderCount", "fetchedAt" FROM "OrderPeriod" WHERE "accountId" = 'user_2legacyAAA' ORDER BY month;
