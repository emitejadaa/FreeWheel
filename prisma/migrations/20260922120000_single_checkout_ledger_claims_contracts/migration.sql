-- Cobro único, libro contable, reclamos por daños, contrato probable,
-- verificación de vehículos y límites de pedidos persistentes.
-- Todo es aditivo: ninguna columna se borra ni cambia de tipo.

-- ── Enums ───────────────────────────────────────────────────────────────────
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'INSPECTION';
ALTER TYPE "PaymentRecordKind" ADD VALUE IF NOT EXISTS 'CHECKOUT';

DO $$ BEGIN
  CREATE TYPE "DamageClaimStatus" AS ENUM ('OPEN', 'ACCEPTED', 'CONTESTED', 'RESOLVED', 'WITHDRAWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "VehicleVerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "VehicleHolderRelation" AS ENUM ('TITULAR', 'AUTORIZADO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── User ────────────────────────────────────────────────────────────────────
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "loginLockedUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMP(3);

-- ── DocumentVerification ────────────────────────────────────────────────────
ALTER TABLE "DocumentVerification" ADD COLUMN IF NOT EXISTS "photosPurgedAt" TIMESTAMP(3);

-- ── Booking ─────────────────────────────────────────────────────────────────
ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "depositHoldExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "checkoutPaymentIntentId" TEXT,
  ADD COLUMN IF NOT EXISTS "savedPaymentMethodId" TEXT,
  ADD COLUMN IF NOT EXISTS "inspectionEndsAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelledByRole" TEXT,
  ADD COLUMN IF NOT EXISTS "cancellationSettlement" JSONB;
CREATE INDEX IF NOT EXISTS "Booking_status_inspectionEndsAt_idx" ON "Booking"("status", "inspectionEndsAt");

-- ── Contract ────────────────────────────────────────────────────────────────
ALTER TABLE "Contract"
  ADD COLUMN IF NOT EXISTS "version" TEXT,
  ADD COLUMN IF NOT EXISTS "contentHash" TEXT,
  ADD COLUMN IF NOT EXISTS "pdfBytes" BYTEA,
  ADD COLUMN IF NOT EXISTS "pdfHash" TEXT,
  ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "ContractAcceptance" (
  "id" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "ipEncrypted" TEXT,
  "userAgentEncrypted" TEXT,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractAcceptance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ContractAcceptance_contractId_userId_contentHash_key"
  ON "ContractAcceptance"("contractId", "userId", "contentHash");
CREATE INDEX IF NOT EXISTS "ContractAcceptance_contractId_idx" ON "ContractAcceptance"("contractId");
CREATE INDEX IF NOT EXISTS "ContractAcceptance_userId_idx" ON "ContractAcceptance"("userId");
DO $$ BEGIN
  ALTER TABLE "ContractAcceptance" ADD CONSTRAINT "ContractAcceptance_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── DamageClaim ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DamageClaim" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "renterId" TEXT NOT NULL,
  "status" "DamageClaimStatus" NOT NULL DEFAULT 'OPEN',
  "description" TEXT NOT NULL,
  "amountRequestedMinor" INTEGER NOT NULL,
  "amountApprovedMinor" INTEGER,
  "currency" TEXT NOT NULL,
  "evidenceUrls" TEXT[],
  "renterResponse" TEXT,
  "renterRespondedAt" TIMESTAMP(3),
  "renterResponseDeadline" TIMESTAMP(3) NOT NULL,
  "resolvedById" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolutionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DamageClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DamageClaim_bookingId_key" ON "DamageClaim"("bookingId");
CREATE INDEX IF NOT EXISTS "DamageClaim_status_idx" ON "DamageClaim"("status");
CREATE INDEX IF NOT EXISTS "DamageClaim_ownerId_idx" ON "DamageClaim"("ownerId");
CREATE INDEX IF NOT EXISTS "DamageClaim_renterId_idx" ON "DamageClaim"("renterId");
DO $$ BEGIN
  ALTER TABLE "DamageClaim" ADD CONSTRAINT "DamageClaim_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Libro contable ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LedgerJournal" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "bookingId" TEXT,
  "description" TEXT NOT NULL,
  "actorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerJournal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerJournal_idempotencyKey_key" ON "LedgerJournal"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "LedgerJournal_bookingId_idx" ON "LedgerJournal"("bookingId");
CREATE INDEX IF NOT EXISTS "LedgerJournal_type_idx" ON "LedgerJournal"("type");
CREATE INDEX IF NOT EXISTS "LedgerJournal_createdAt_idx" ON "LedgerJournal"("createdAt");

CREATE TABLE IF NOT EXISTS "LedgerEntry" (
  "id" TEXT NOT NULL,
  "journalId" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "bookingId" TEXT,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "LedgerEntry_journalId_idx" ON "LedgerEntry"("journalId");
CREATE INDEX IF NOT EXISTS "LedgerEntry_account_idx" ON "LedgerEntry"("account");
CREATE INDEX IF NOT EXISTS "LedgerEntry_bookingId_idx" ON "LedgerEntry"("bookingId");
CREATE INDEX IF NOT EXISTS "LedgerEntry_userId_idx" ON "LedgerEntry"("userId");
DO $$ BEGIN
  ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_journalId_fkey"
    FOREIGN KEY ("journalId") REFERENCES "LedgerJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── VehicleVerification ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "VehicleVerification" (
  "id" TEXT NOT NULL,
  "vehicleId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "status" "VehicleVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "cedulaFrontUrl" TEXT,
  "cedulaBackUrl" TEXT,
  "plate" TEXT NOT NULL,
  "chassisNumberEncrypted" TEXT,
  "holderRelation" "VehicleHolderRelation" NOT NULL,
  "holderName" TEXT NOT NULL,
  "holderDniEncrypted" TEXT,
  "insurerName" TEXT,
  "insurancePolicyNumberEncrypted" TEXT,
  "insuranceExpiresAt" TIMESTAMP(3),
  "insuranceCoversRental" BOOLEAN NOT NULL DEFAULT false,
  "vtvExpiresAt" TIMESTAMP(3),
  "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "notes" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "photosPurgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VehicleVerification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "VehicleVerification_vehicleId_key" ON "VehicleVerification"("vehicleId");
CREATE INDEX IF NOT EXISTS "VehicleVerification_status_idx" ON "VehicleVerification"("status");
CREATE INDEX IF NOT EXISTS "VehicleVerification_ownerId_idx" ON "VehicleVerification"("ownerId");
CREATE INDEX IF NOT EXISTS "VehicleVerification_plate_idx" ON "VehicleVerification"("plate");
DO $$ BEGIN
  ALTER TABLE "VehicleVerification" ADD CONSTRAINT "VehicleVerification_vehicleId_fkey"
    FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── RateLimitBucket ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RateLimitBucket" (
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "blockedUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);
CREATE INDEX IF NOT EXISTS "RateLimitBucket_updatedAt_idx" ON "RateLimitBucket"("updatedAt");
