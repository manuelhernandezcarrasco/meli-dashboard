-- Single-tenant tables become per-user (Clerk user id). The cache and snapshots are
-- regenerable and the old singleton token row has no owner, so the tables are recreated.
DROP TABLE "MlToken";
DROP TABLE "ApiCache";
DROP TABLE "Snapshot";

CREATE TABLE "MlToken" (
    "ownerId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlToken_pkey" PRIMARY KEY ("ownerId")
);

CREATE TABLE "ApiCache" (
    "ownerId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiCache_pkey" PRIMARY KEY ("ownerId","key")
);

CREATE TABLE "Snapshot" (
    "ownerId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("ownerId","month")
);
