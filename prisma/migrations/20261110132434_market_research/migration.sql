-- CreateTable
CREATE TABLE "MarketResearch" (
    "ownerId" TEXT NOT NULL,
    "catalogProductId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketResearch_pkey" PRIMARY KEY ("ownerId","catalogProductId")
);
