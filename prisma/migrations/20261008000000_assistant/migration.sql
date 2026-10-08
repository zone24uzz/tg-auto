-- CreateEnum
CREATE TYPE "AssistantTaskKind" AS ENUM ('WATCH_ONLINE', 'WATCH_MESSAGE', 'REMINDER', 'SEND_MESSAGE');

-- CreateTable
CREATE TABLE "assistant_tasks" (
    "id" SERIAL NOT NULL,
    "kind" "AssistantTaskKind" NOT NULL,
    "targetTelegramUserId" BIGINT,
    "targetLabel" TEXT,
    "text" TEXT,
    "runAt" TIMESTAMP(3),
    "repeat" BOOLEAN NOT NULL DEFAULT false,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "lastPresence" TEXT,
    "triggerCount" INTEGER NOT NULL DEFAULT 0,
    "lastTriggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_tasks_active_kind_idx" ON "assistant_tasks"("active", "kind");

-- CreateIndex
CREATE INDEX "assistant_tasks_targetTelegramUserId_idx" ON "assistant_tasks"("targetTelegramUserId");

