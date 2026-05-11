ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
CREATE TYPE "VerificationCodePurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');
ALTER TABLE "VerificationCode" ADD COLUMN "purpose" "VerificationCodePurpose" NOT NULL DEFAULT 'EMAIL_VERIFICATION';