CREATE TABLE "MatchDecision" (
    "ownerId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchDecision_pkey" PRIMARY KEY ("ownerId","itemId","ean")
);
