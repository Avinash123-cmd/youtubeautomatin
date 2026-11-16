ALTER TYPE "OtpPurpose" ADD VALUE 'SESSION_REVOCATION';
-- Additive only: legacy identities, users, sessions and workspaces are preserved.
CREATE TABLE "TelegramBotLoginChallenge" (
  "id" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "browserHash" TEXT NOT NULL,
  "userId" UUID,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TelegramBotLoginChallenge_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TelegramBotLoginChallenge_tokenHash_key" ON "TelegramBotLoginChallenge"("tokenHash");
CREATE UNIQUE INDEX "TelegramBotLoginChallenge_browserHash_key" ON "TelegramBotLoginChallenge"("browserHash");
CREATE INDEX "TelegramBotLoginChallenge_expiresAt_idx" ON "TelegramBotLoginChallenge"("expiresAt");
CREATE INDEX "TelegramBotLoginChallenge_userId_idx" ON "TelegramBotLoginChallenge"("userId");
ALTER TABLE "TelegramBotLoginChallenge" ADD CONSTRAINT "TelegramBotLoginChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "TelegramBotUpdate" (
  "id" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TelegramBotUpdate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TelegramBotUpdate_createdAt_idx" ON "TelegramBotUpdate"("createdAt");
