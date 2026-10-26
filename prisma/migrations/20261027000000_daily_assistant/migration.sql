-- Reply drafts for the owner (encrypted JSON array of suggested replies).
ALTER TABLE "owner_attention" ADD COLUMN "suggestions" TEXT;

-- Birthdays of contacts: MM-DD or YYYY-MM-DD, where it came from, and the last year a greeting was offered.
ALTER TABLE "users" ADD COLUMN "birthday" TEXT;
ALTER TABLE "users" ADD COLUMN "birthdaySource" TEXT;
ALTER TABLE "users" ADD COLUMN "birthdayNotifiedYear" INTEGER;
CREATE INDEX "users_tenantId_birthday_idx" ON "users"("tenantId", "birthday");

-- Off-hours / busy notices sent to contacts (own kind: their cooldown differs from waiting notices).
ALTER TYPE "ResponseKind" ADD VALUE 'STATUS_NOTICE';
