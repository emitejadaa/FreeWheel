-- Identidad declarada por su dueño (la lectura solo corrobora) + registro
-- append-only de todo lo que le pasa a un cobro.

-- ── User ────────────────────────────────────────────────────────────────────
ALTER TABLE "User" DROP COLUMN IF EXISTS "address";

-- ── DocumentVerification ────────────────────────────────────────────────────
ALTER TABLE "DocumentVerification" DROP COLUMN IF EXISTS "extracted";
ALTER TABLE "DocumentVerification" ADD COLUMN IF NOT EXISTS "declared" JSONB;
ALTER TABLE "DocumentVerification" ADD COLUMN IF NOT EXISTS "checks" JSONB;
ALTER TABLE "DocumentVerification"
  ADD COLUMN IF NOT EXISTS "retakeSlots" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ── Estados que faltaban ────────────────────────────────────────────────────
ALTER TYPE "PaymentRecordStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "PaymentRecordStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';

-- ── PaymentRecord: qué hace falta para reconstruir un cobro discutido ───────
ALTER TABLE "PaymentRecord"
  ADD COLUMN IF NOT EXISTS "refundedAmountMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cardBrand" TEXT,
  ADD COLUMN IF NOT EXISTS "cardLast4" TEXT,
  ADD COLUMN IF NOT EXISTS "cardFingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "cardCountry" TEXT,
  ADD COLUMN IF NOT EXISTS "riskLevel" TEXT,
  ADD COLUMN IF NOT EXISTS "riskScore" INTEGER,
  ADD COLUMN IF NOT EXISTS "initiatedIp" TEXT,
  ADD COLUMN IF NOT EXISTS "initiatedUserAgent" TEXT,
  ADD COLUMN IF NOT EXISTS "failureCode" TEXT,
  ADD COLUMN IF NOT EXISTS "failureMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "capturedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "releasedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "disputedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "PaymentRecord_cardFingerprint_idx"
  ON "PaymentRecord"("cardFingerprint");

-- ── PaymentEvent ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PaymentEvent" (
  "id"              TEXT NOT NULL,
  "paymentRecordId" TEXT,
  "bookingId"       TEXT,
  "actorId"         TEXT,
  "source"          TEXT NOT NULL,
  "type"            TEXT NOT NULL,
  "status"          "PaymentRecordStatus",
  "amountMinor"     INTEGER,
  "currency"        TEXT,
  "providerEventId" TEXT,
  "ip"              TEXT,
  "userAgent"       TEXT,
  "payload"         JSONB,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentEvent_providerEventId_key"
  ON "PaymentEvent"("providerEventId");
CREATE INDEX IF NOT EXISTS "PaymentEvent_paymentRecordId_createdAt_idx"
  ON "PaymentEvent"("paymentRecordId", "createdAt");
CREATE INDEX IF NOT EXISTS "PaymentEvent_bookingId_createdAt_idx"
  ON "PaymentEvent"("bookingId", "createdAt");
CREATE INDEX IF NOT EXISTS "PaymentEvent_type_idx" ON "PaymentEvent"("type");
CREATE INDEX IF NOT EXISTS "PaymentEvent_createdAt_idx" ON "PaymentEvent"("createdAt");

DO $$
BEGIN
  ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_paymentRecordId_fkey"
    FOREIGN KEY ("paymentRecordId") REFERENCES "PaymentRecord"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
