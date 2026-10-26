-- CreateTable
CREATE TABLE "google_accounts" (
    "tenantId" INTEGER NOT NULL DEFAULT 0,
    "email" TEXT,
    "refreshToken" TEXT NOT NULL,
    "accessToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "remindedEventIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_accounts_pkey" PRIMARY KEY ("tenantId")
);


-- Fail closed: rows written without a tenant are rejected (Prisma does not manage CHECK constraints).
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_tenant_check" CHECK ("tenantId" > 0);

