-- CreateEnum
CREATE TYPE "ChannelPostStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED');

-- CreateTable
CREATE TABLE "channels" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL DEFAULT 0,
    "telegramChatId" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "username" TEXT,
    "addedByTelegramUserId" BIGINT NOT NULL,
    "canPost" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_posts" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL DEFAULT 0,
    "channelId" INTEGER NOT NULL,
    "instructions" TEXT,
    "text" TEXT NOT NULL,
    "status" "ChannelPostStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channels_tenantId_telegramChatId_key" ON "channels"("tenantId", "telegramChatId");

-- CreateIndex
CREATE INDEX "channel_posts_tenantId_status_idx" ON "channel_posts"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "channel_posts" ADD CONSTRAINT "channel_posts_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Fail closed: rows written without a tenant are rejected (Prisma does not manage CHECK constraints).
ALTER TABLE "channels" ADD CONSTRAINT "channels_tenant_check" CHECK ("tenantId" > 0);
ALTER TABLE "channel_posts" ADD CONSTRAINT "channel_posts_tenant_check" CHECK ("tenantId" > 0);

