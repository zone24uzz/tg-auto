-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('OWNER');

-- CreateEnum
CREATE TYPE "UserMode" AS ENUM ('AUTO', 'MANUAL', 'IGNORE', 'VIP', 'BLOCK');

-- CreateEnum
CREATE TYPE "RuleMatchType" AS ENUM ('USER_ID', 'USERNAME', 'CHAT_ID', 'TAG');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INCOMING', 'OUTGOING_OWNER', 'OUTGOING_BOT');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'PHOTO', 'VOICE', 'AUDIO', 'VIDEO', 'VIDEO_NOTE', 'DOCUMENT', 'STICKER', 'ANIMATION', 'CONTACT', 'LOCATION', 'POLL', 'OTHER');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSING', 'ANSWERED', 'OWNER_ATTENTION', 'MANUAL', 'IGNORED', 'SKIPPED', 'RATE_LIMITED', 'FAILED');

-- CreateEnum
CREATE TYPE "Classification" AS ENUM ('NORMAL', 'PERSONAL', 'SENSITIVE', 'REQUIRES_OWNER', 'BUSINESS', 'SPAM', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('PHOTO', 'VOICE', 'AUDIO', 'VIDEO', 'VIDEO_NOTE', 'DOCUMENT', 'STICKER', 'ANIMATION');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'SKIPPED', 'TOO_LARGE', 'UNSUPPORTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ResponseKind" AS ENUM ('AUTO_REPLY', 'PERSONAL_NOTICE', 'FALLBACK', 'OWNER_APPROVED_AI', 'OWNER_MANUAL', 'LIMIT_NOTICE', 'MEDIA_NOTICE');

-- CreateEnum
CREATE TYPE "ResponseStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "AttentionStatus" AS ENUM ('PENDING', 'REPLIED', 'AI_REPLIED', 'IGNORED', 'RESOLVED_BY_OWNER');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('AUTO_REPLY_ENABLED', 'AUTO_REPLY_DISABLED', 'AUTO_REPLY_PAUSED', 'MODEL_CHANGED', 'PROVIDER_CHANGED', 'REASONING_CHANGED', 'PROMPT_CHANGED', 'PROMPT_RESTORED', 'PROMPT_RESET', 'USER_RULE_CHANGED', 'USER_BLOCKED', 'USER_UNBLOCKED', 'SETTING_CHANGED', 'OWNER_ATTENTION_RESOLVED', 'DATA_DELETED', 'CONNECTION_CHANGED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "EventLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "admins" (
    "id" SERIAL NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_states" (
    "telegramUserId" BIGINT NOT NULL,
    "state" TEXT NOT NULL,
    "payload" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_states_pkey" PRIMARY KEY ("telegramUserId")
);

-- CreateTable
CREATE TABLE "telegram_connections" (
    "id" TEXT NOT NULL,
    "ownerUserId" BIGINT NOT NULL,
    "userChatId" BIGINT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "canReply" BOOLEAN NOT NULL DEFAULT false,
    "authorized" BOOLEAN NOT NULL DEFAULT false,
    "rights" JSONB,
    "connectedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "languageCode" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chats" (
    "id" SERIAL NOT NULL,
    "connectionId" TEXT NOT NULL,
    "telegramChatId" BIGINT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'private',
    "title" TEXT,
    "userId" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3),
    "lastOwnerMessageAt" TIMESTAMP(3),
    "processingUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "chatId" INTEGER NOT NULL,
    "senderId" INTEGER,
    "telegramMessageId" INTEGER NOT NULL,
    "direction" "MessageDirection" NOT NULL DEFAULT 'INCOMING',
    "type" "MessageType" NOT NULL,
    "currentText" TEXT,
    "currentCaption" TEXT,
    "replyToTelegramMessageId" INTEGER,
    "forwardInfo" JSONB,
    "mediaGroupId" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'RECEIVED',
    "statusReason" TEXT,
    "classification" "Classification",
    "classificationConfidence" DOUBLE PRECISION,
    "classificationReason" TEXT,
    "injectionSuspected" BOOLEAN NOT NULL DEFAULT false,
    "versionCount" INTEGER NOT NULL DEFAULT 1,
    "telegramDate" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_versions" (
    "id" SERIAL NOT NULL,
    "messageId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT,
    "caption" TEXT,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" SERIAL NOT NULL,
    "messageId" INTEGER NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "telegramFileId" TEXT NOT NULL,
    "telegramFileUniqueId" TEXT NOT NULL,
    "mimeType" TEXT,
    "fileName" TEXT,
    "fileSize" INTEGER,
    "durationSec" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "emoji" TEXT,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "extractedText" TEXT,
    "description" TEXT,
    "storageKey" TEXT,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_responses" (
    "id" SERIAL NOT NULL,
    "sourceMessageId" INTEGER NOT NULL,
    "chatId" INTEGER NOT NULL,
    "kind" "ResponseKind" NOT NULL,
    "status" "ResponseStatus" NOT NULL DEFAULT 'PENDING',
    "text" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "reasoningEffort" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "usedFallback" BOOLEAN NOT NULL DEFAULT false,
    "sentTelegramMessageId" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "ai_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_summaries" (
    "id" SERIAL NOT NULL,
    "chatId" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "coveredUntilMessageId" INTEGER NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_stats" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "audioSeconds" INTEGER NOT NULL DEFAULT 0,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "messageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_rules" (
    "id" SERIAL NOT NULL,
    "matchType" "RuleMatchType" NOT NULL,
    "matchValue" TEXT NOT NULL,
    "mode" "UserMode" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" BIGINT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "prompts" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'SYSTEM',
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owner_attention" (
    "id" SERIAL NOT NULL,
    "messageId" INTEGER NOT NULL,
    "chatId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "status" "AttentionStatus" NOT NULL DEFAULT 'PENDING',
    "adminNotificationMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "owner_attention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "adminTelegramUserId" BIGINT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "target" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_events" (
    "id" SERIAL NOT NULL,
    "level" "EventLevel" NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_updates" (
    "botKind" TEXT NOT NULL,
    "updateId" BIGINT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_updates_pkey" PRIMARY KEY ("botKind","updateId")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" SERIAL NOT NULL,
    "queue" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_telegramUserId_key" ON "admins"("telegramUserId");

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramUserId_key" ON "users"("telegramUserId");

-- CreateIndex
CREATE INDEX "users_username_idx" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_lastMessageAt_idx" ON "users"("lastMessageAt");

-- CreateIndex
CREATE INDEX "chats_telegramChatId_idx" ON "chats"("telegramChatId");

-- CreateIndex
CREATE UNIQUE INDEX "chats_connectionId_telegramChatId_key" ON "chats"("connectionId", "telegramChatId");

-- CreateIndex
CREATE INDEX "messages_chatId_telegramDate_idx" ON "messages"("chatId", "telegramDate");

-- CreateIndex
CREATE INDEX "messages_senderId_createdAt_idx" ON "messages"("senderId", "createdAt");

-- CreateIndex
CREATE INDEX "messages_createdAt_idx" ON "messages"("createdAt");

-- CreateIndex
CREATE INDEX "messages_status_idx" ON "messages"("status");

-- CreateIndex
CREATE INDEX "messages_deletedAt_idx" ON "messages"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "messages_chatId_telegramMessageId_key" ON "messages"("chatId", "telegramMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "message_versions_messageId_version_key" ON "message_versions"("messageId", "version");

-- CreateIndex
CREATE INDEX "media_messageId_idx" ON "media"("messageId");

-- CreateIndex
CREATE INDEX "media_expiresAt_idx" ON "media"("expiresAt");

-- CreateIndex
CREATE INDEX "ai_responses_chatId_createdAt_idx" ON "ai_responses"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_responses_createdAt_idx" ON "ai_responses"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_responses_sourceMessageId_kind_key" ON "ai_responses"("sourceMessageId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_summaries_chatId_key" ON "conversation_summaries"("chatId");

-- CreateIndex
CREATE INDEX "usage_stats_createdAt_idx" ON "usage_stats"("createdAt");

-- CreateIndex
CREATE INDEX "usage_stats_provider_model_idx" ON "usage_stats"("provider", "model");

-- CreateIndex
CREATE INDEX "user_rules_mode_idx" ON "user_rules"("mode");

-- CreateIndex
CREATE UNIQUE INDEX "user_rules_matchType_matchValue_key" ON "user_rules"("matchType", "matchValue");

-- CreateIndex
CREATE INDEX "prompts_kind_isActive_idx" ON "prompts"("kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "prompts_kind_version_key" ON "prompts"("kind", "version");

-- CreateIndex
CREATE UNIQUE INDEX "owner_attention_messageId_key" ON "owner_attention"("messageId");

-- CreateIndex
CREATE INDEX "owner_attention_status_createdAt_idx" ON "owner_attention"("status", "createdAt");

-- CreateIndex
CREATE INDEX "owner_attention_chatId_status_idx" ON "owner_attention"("chatId", "status");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "system_events_createdAt_idx" ON "system_events"("createdAt");

-- CreateIndex
CREATE INDEX "processed_updates_receivedAt_idx" ON "processed_updates"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_dedupeKey_key" ON "jobs"("dedupeKey");

-- CreateIndex
CREATE INDEX "jobs_queue_status_runAt_idx" ON "jobs"("queue", "status", "runAt");

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "telegram_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_responses" ADD CONSTRAINT "ai_responses_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_responses" ADD CONSTRAINT "ai_responses_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_attention" ADD CONSTRAINT "owner_attention_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_attention" ADD CONSTRAINT "owner_attention_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

