-- Add Google OAuth and terms acceptance to User
ALTER TABLE "User"
  ADD COLUMN "googleId" TEXT,
  ADD COLUMN "acceptedTermsAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- Add purpose to VerificationCode (email verification vs password reset)
CREATE TYPE "VerificationCodePurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

ALTER TABLE "VerificationCode"
  ADD COLUMN "purpose" "VerificationCodePurpose" NOT NULL DEFAULT 'EMAIL_VERIFICATION';