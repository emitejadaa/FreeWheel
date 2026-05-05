-- Add profile and verification fields without storing raw identity documents.
CREATE TYPE "VerificationStatus" AS ENUM (
  'UNVERIFIED',
  'EMAIL_VERIFIED',
  'PHONE_VERIFIED',
  'ID_SUBMITTED',
  'VERIFIED',
  'REJECTED'
);

ALTER TYPE "UserStatus" ADD VALUE 'PENDING_VERIFICATION';

ALTER TABLE "User"
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "profilePhotoUrl" TEXT,
  ADD COLUMN "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED';

CREATE TABLE "UserVerification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "VerificationStatus" NOT NULL DEFAULT 'ID_SUBMITTED',
  "documentUrl" TEXT,
  "selfieUrl" TEXT,
  "notes" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserVerification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "User_verificationStatus_idx" ON "User"("verificationStatus");
CREATE INDEX "UserVerification_userId_idx" ON "UserVerification"("userId");
CREATE INDEX "UserVerification_status_idx" ON "UserVerification"("status");

ALTER TABLE "UserVerification"
  ADD CONSTRAINT "UserVerification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
