-- Multi-tenancy: every workspace (Telegram account owner) gets its own settings, rules, prompts,
-- history, AI key and userbot session. The existing single owner becomes tenant #1.

-- 1. Tenants table (created before "admins" is dropped so the owner can be carried over).
CREATE TYPE "TenantStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED');

CREATE TABLE "tenants" (
    "id" SERIAL NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "status" "TenantStatus" NOT NULL DEFAULT 'PENDING',
    "language" TEXT NOT NULL DEFAULT 'uz',
    "aiProvider" TEXT,
    "aiApiKey" TEXT,
    "onboardingStep" TEXT,
    "consentAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenants_telegramUserId_key" ON "tenants"("telegramUserId");
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- The current owner becomes tenant #1, already active. If ADMIN_TELEGRAM_USER_ID ever changed, "admins"
-- holds several rows: pick the account that actually owns the data (authorized connection, then the
-- userbot session), otherwise the most recently added admin — never blindly the oldest row.
INSERT INTO "tenants" ("telegramUserId", "status", "language", "approvedAt", "consentAt", "updatedAt")
SELECT a."telegramUserId", 'ACTIVE', 'uz', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "admins" a
 ORDER BY
   EXISTS (SELECT 1 FROM "telegram_connections" c WHERE c."ownerUserId" = a."telegramUserId" AND c."authorized") DESC,
   EXISTS (SELECT 1 FROM "userbot_sessions" s WHERE s."ownerUserId" = a."telegramUserId") DESC,
   a."createdAt" DESC,
   a."id" DESC
 LIMIT 1;

-- 2. Drop indexes that become tenant-scoped.
DROP INDEX "assistant_tasks_active_kind_idx";
DROP INDEX "chats_telegramChatId_idx";
DROP INDEX "prompts_kind_isActive_idx";
DROP INDEX "prompts_kind_version_key";
DROP INDEX "user_rules_matchType_matchValue_key";
DROP INDEX "user_rules_mode_idx";
DROP INDEX "users_lastMessageAt_idx";
DROP INDEX "users_telegramUserId_key";
DROP INDEX "users_username_idx";

-- 3. tenantId columns (0 = "not set"; rejected by the CHECK constraints below).
ALTER TABLE "ai_responses" ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assistant_tasks" ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "audit_logs" ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "chats" ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "messages" ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "owner_attention" ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "prompts" ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "settings" DROP CONSTRAINT "settings_pkey",
ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "settings_pkey" PRIMARY KEY ("tenantId", "key");
ALTER TABLE "system_events" ADD COLUMN "tenantId" INTEGER;
ALTER TABLE "telegram_connections" ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usage_stats" ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "user_rules" ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "userbot_sessions" DROP CONSTRAINT "userbot_sessions_pkey",
DROP COLUMN "id",
ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "userbot_sessions_pkey" PRIMARY KEY ("tenantId");
ALTER TABLE "users" ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0;

-- 4. Existing data belongs to tenant #1 (no-op on an empty database).
UPDATE "ai_responses" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;
UPDATE "assistant_tasks" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;
UPDATE "audit_logs" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;
UPDATE "chats" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;
UPDATE "messages" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;
UPDATE "owner_attention" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;
UPDATE "prompts" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;
UPDATE "settings" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;
UPDATE "telegram_connections" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;
UPDATE "usage_stats" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;
UPDATE "user_rules" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;
UPDATE "userbot_sessions" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;
UPDATE "users" SET "tenantId" = (SELECT MIN("id") FROM "tenants") WHERE "tenantId" = 0;

-- 5. Tenant-scoped indexes.
CREATE INDEX "ai_responses_tenantId_createdAt_idx" ON "ai_responses"("tenantId", "createdAt");
CREATE INDEX "assistant_tasks_tenantId_active_kind_idx" ON "assistant_tasks"("tenantId", "active", "kind");
CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt");
CREATE INDEX "chats_tenantId_telegramChatId_idx" ON "chats"("tenantId", "telegramChatId");
CREATE INDEX "messages_tenantId_createdAt_idx" ON "messages"("tenantId", "createdAt");
CREATE INDEX "owner_attention_tenantId_status_createdAt_idx" ON "owner_attention"("tenantId", "status", "createdAt");
CREATE INDEX "prompts_tenantId_kind_isActive_idx" ON "prompts"("tenantId", "kind", "isActive");
CREATE UNIQUE INDEX "prompts_tenantId_kind_version_key" ON "prompts"("tenantId", "kind", "version");
CREATE INDEX "system_events_tenantId_createdAt_idx" ON "system_events"("tenantId", "createdAt");
CREATE INDEX "telegram_connections_tenantId_idx" ON "telegram_connections"("tenantId");
CREATE INDEX "usage_stats_tenantId_createdAt_idx" ON "usage_stats"("tenantId", "createdAt");
CREATE INDEX "user_rules_tenantId_mode_idx" ON "user_rules"("tenantId", "mode");
CREATE UNIQUE INDEX "user_rules_tenantId_matchType_matchValue_key" ON "user_rules"("tenantId", "matchType", "matchValue");
CREATE INDEX "users_tenantId_username_idx" ON "users"("tenantId", "username");
CREATE INDEX "users_tenantId_lastMessageAt_idx" ON "users"("tenantId", "lastMessageAt");
CREATE UNIQUE INDEX "users_tenantId_telegramUserId_key" ON "users"("tenantId", "telegramUserId");

-- 6. Fail closed: a row written without a tenant (tenantId left at its default 0) is rejected.
--    (Prisma does not manage CHECK constraints, so later migrations never drop them.)
ALTER TABLE "ai_responses" ADD CONSTRAINT "ai_responses_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "assistant_tasks" ADD CONSTRAINT "assistant_tasks_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "chats" ADD CONSTRAINT "chats_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "owner_attention" ADD CONSTRAINT "owner_attention_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "settings" ADD CONSTRAINT "settings_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "system_events" ADD CONSTRAINT "system_events_tenant_check" CHECK ("tenantId" IS NULL OR "tenantId" > 0);
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "usage_stats" ADD CONSTRAINT "usage_stats_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "user_rules" ADD CONSTRAINT "user_rules_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "userbot_sessions" ADD CONSTRAINT "userbot_sessions_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_check" CHECK ("tenantId" > 0);

-- 7. The single-admin table is replaced by tenants.
DROP TABLE "admins";
DROP TYPE "AdminRole";
