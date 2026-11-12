-- CreateTable
CREATE TABLE "CompetitorSale" (
    "accountId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "itemId" TEXT NOT NULL,
    "sold" INTEGER NOT NULL,
    "nickname" TEXT,
    "collectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorSale_pkey" PRIMARY KEY ("accountId","marketplace","itemId")
);

-- AddForeignKey
ALTER TABLE "CompetitorSale" ADD CONSTRAINT "CompetitorSale_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Copy the readings the browser collector stored in the deprecated ApiCache (`sold:<itemId>` keys).
INSERT INTO "CompetitorSale" ("accountId", "marketplace", "itemId", "sold", "nickname")
SELECT c."ownerId", 'mercadolibre', upper(substr(c."key", 6)), (c."value"->>'sold')::int, c."value"->>'nickname'
FROM "ApiCache" c
WHERE c."key" LIKE 'sold:%' AND (c."value"->>'sold') ~ '^[0-9]+$'
  AND EXISTS (SELECT 1 FROM "Account" a WHERE a."id" = c."ownerId")
ON CONFLICT DO NOTHING;
