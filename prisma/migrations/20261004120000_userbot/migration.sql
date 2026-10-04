-- AlterTable
ALTER TABLE "chats" ADD COLUMN     "processingToken" TEXT;

-- AlterTable
ALTER TABLE "owner_attention" ADD COLUMN     "burstMessageIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "accessHash" TEXT,
ADD COLUMN     "isContact" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "userbot_sessions" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "session" TEXT NOT NULL,
    "ownerUserId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "userbot_sessions_pkey" PRIMARY KEY ("id")
);

