CREATE TABLE "UserWorkbook" (
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserWorkbook_pkey" PRIMARY KEY ("ownerId","kind")
);
