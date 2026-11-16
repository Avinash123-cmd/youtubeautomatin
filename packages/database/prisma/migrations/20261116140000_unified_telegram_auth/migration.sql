-- Add Telegram OIDC identity and short-lived, single-use OAuth/link transactions.
-- Existing users and their Telegram notification chat IDs remain intact.
ALTER TYPE "LoginMethod" ADD VALUE 'TELEGRAM';
ALTER TYPE "AuditAction" ADD VALUE 'AUTH_TELEGRAM_DISCONNECTED';

ALTER TABLE "User"
  ADD COLUMN "telegramLoginId" TEXT,
  ADD COLUMN "telegramUserId" TEXT,
  ADD COLUMN "telegramUsername" TEXT;

CREATE UNIQUE INDEX "User_telegramLoginId_key" ON "User"("telegramLoginId");
CREATE UNIQUE INDEX "User_telegramUserId_key" ON "User"("telegramUserId");

CREATE TABLE "TelegramOidcTransaction" (
  "id" UUID NOT NULL,
  "stateHash" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "codeVerifier" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TelegramOidcTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TelegramOidcTransaction_stateHash_key" ON "TelegramOidcTransaction"("stateHash");
CREATE INDEX "TelegramOidcTransaction_expiresAt_idx" ON "TelegramOidcTransaction"("expiresAt");

CREATE TABLE "TelegramConnectionToken" (
  "id" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TelegramConnectionToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TelegramConnectionToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TelegramConnectionToken_tokenHash_key" ON "TelegramConnectionToken"("tokenHash");
CREATE INDEX "TelegramConnectionToken_userId_consumedAt_idx" ON "TelegramConnectionToken"("userId", "consumedAt");
CREATE INDEX "TelegramConnectionToken_expiresAt_idx" ON "TelegramConnectionToken"("expiresAt");
