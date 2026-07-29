-- Reseñas, reportes y control del cambio de precio.
--
-- Escrita para poder correrse dos veces sin romperse (IF NOT EXISTS y guardas),
-- igual que las migraciones anteriores de este repo: la base la administra otra
-- persona y el deploy puede sincronizarla con `db push`.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportTargetType') THEN
    CREATE TYPE "ReportTargetType" AS ENUM ('LISTING', 'USER');
  END IF;
END $$;

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportStatus') THEN
    CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'ACTION_TAKEN', 'DISMISSED');
  END IF;
END $$;

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportAiVerdict') THEN
    CREATE TYPE "ReportAiVerdict" AS ENUM ('COHERENT', 'INCOHERENT', 'UNCLEAR');
  END IF;
END $$;

-- AlterEnum
ALTER TYPE "VerificationCodePurpose" ADD VALUE IF NOT EXISTS 'PRICE_CHANGE';

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "pendingPricePerDay" DOUBLE PRECISION;
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "priceChangeRequestedAt" TIMESTAMP(3);
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "priceUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "ratingAverage" DOUBLE PRECISION;
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "ratingCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "ratingAverage" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "ratingCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Review" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "listingId" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Report" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "listingId" TEXT,
    "targetUserId" TEXT,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "aiVerdict" "ReportAiVerdict",
    "aiSummary" TEXT,
    "aiCheckedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Review_listingId_createdAt_idx" ON "Review"("listingId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Review_targetUserId_createdAt_idx" ON "Review"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Review_authorId_idx" ON "Review"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Review_bookingId_authorId_key" ON "Review"("bookingId", "authorId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Report_status_createdAt_idx" ON "Report"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Report_listingId_idx" ON "Report"("listingId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Report_reporterId_idx" ON "Report"("reporterId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Review_bookingId_fkey') THEN
    ALTER TABLE "Review" ADD CONSTRAINT "Review_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Review_authorId_fkey') THEN
    ALTER TABLE "Review" ADD CONSTRAINT "Review_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Review_targetUserId_fkey') THEN
    ALTER TABLE "Review" ADD CONSTRAINT "Review_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Review_listingId_fkey') THEN
    ALTER TABLE "Review" ADD CONSTRAINT "Review_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Report_reporterId_fkey') THEN
    ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Report_targetUserId_fkey') THEN
    ALTER TABLE "Report" ADD CONSTRAINT "Report_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Report_listingId_fkey') THEN
    ALTER TABLE "Report" ADD CONSTRAINT "Report_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Report_resolvedById_fkey') THEN
    ALTER TABLE "Report" ADD CONSTRAINT "Report_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
