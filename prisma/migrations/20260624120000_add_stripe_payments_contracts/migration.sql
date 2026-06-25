-- CreateEnum
CREATE TYPE "PaymentRecordKind" AS ENUM ('SENA', 'BALANCE', 'DEPOSIT_HOLD', 'DEPOSIT_CAPTURE', 'OWNER_TRANSFER', 'REFUND', 'MOCK');

-- CreateEnum
CREATE TYPE "StripeAccountStatus" AS ENUM ('NONE', 'PENDING', 'ENABLED', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('PENDING_ACCEPTANCE', 'ACCEPTED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentStatus" ADD VALUE 'DEPOSIT_PAID';
ALTER TYPE "PaymentStatus" ADD VALUE 'FULLY_PAID';
ALTER TYPE "PaymentStatus" ADD VALUE 'PARTIALLY_REFUNDED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentRecordStatus" ADD VALUE 'REQUIRES_ACTION';
ALTER TYPE "PaymentRecordStatus" ADD VALUE 'AUTHORIZED';
ALTER TYPE "PaymentRecordStatus" ADD VALUE 'CAPTURED';
ALTER TYPE "PaymentRecordStatus" ADD VALUE 'RELEASED';
ALTER TYPE "PaymentRecordStatus" ADD VALUE 'PARTIALLY_REFUNDED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "stripeAccountId" TEXT,
ADD COLUMN     "stripeAccountStatus" "StripeAccountStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "stripeCustomerId" TEXT;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "balanceAmountSnapshot" DOUBLE PRECISION,
ADD COLUMN     "depositCapturedAmount" DOUBLE PRECISION,
ADD COLUMN     "depositPaymentIntentId" TEXT,
ADD COLUMN     "insuranceSnapshot" DOUBLE PRECISION,
ADD COLUMN     "ownerPayoutSnapshot" DOUBLE PRECISION,
ADD COLUMN     "ownerTransferId" TEXT,
ADD COLUMN     "rentalSubtotalSnapshot" DOUBLE PRECISION,
ADD COLUMN     "senaAmountSnapshot" DOUBLE PRECISION,
ADD COLUMN     "transferGroup" TEXT;

-- AlterTable
ALTER TABLE "PaymentRecord" ADD COLUMN     "amountMinor" INTEGER,
ADD COLUMN     "applicationFeeMinor" INTEGER,
ADD COLUMN     "kind" "PaymentRecordKind",
ADD COLUMN     "stripeChargeId" TEXT,
ADD COLUMN     "stripePaymentIntentId" TEXT,
ADD COLUMN     "stripeRefundId" TEXT,
ADD COLUMN     "stripeTransferId" TEXT;

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
    "terms" JSONB NOT NULL,
    "pdfStorageKey" TEXT,
    "pdfUrl" TEXT,
    "renterAcceptedAt" TIMESTAMP(3),
    "ownerAcceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StripeEvent_eventId_key" ON "StripeEvent"("eventId");

-- CreateIndex
CREATE INDEX "StripeEvent_type_idx" ON "StripeEvent"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_bookingId_key" ON "Contract"("bookingId");

-- CreateIndex
CREATE INDEX "Contract_status_idx" ON "Contract"("status");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeAccountId_key" ON "User"("stripeAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecord_stripePaymentIntentId_key" ON "PaymentRecord"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "PaymentRecord_kind_idx" ON "PaymentRecord"("kind");

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

