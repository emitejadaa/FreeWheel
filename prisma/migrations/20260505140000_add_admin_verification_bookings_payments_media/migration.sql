CREATE TYPE "VerificationCodeTargetType" AS ENUM ('EMAIL', 'PHONE');
CREATE TYPE "BookingStatus" AS ENUM (
  'REQUESTED',
  'ACCEPTED',
  'REJECTED',
  'CANCELLED_BY_RENTER',
  'CANCELLED_BY_OWNER',
  'READY_FOR_PICKUP',
  'IN_PROGRESS',
  'RETURN_PENDING',
  'COMPLETED',
  'DISPUTED'
);
CREATE TYPE "PaymentStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PAID', 'REFUNDED', 'FAILED');
CREATE TYPE "PaymentRecordStatus" AS ENUM ('MOCK', 'PENDING', 'PAID', 'REFUNDED', 'FAILED', 'CANCELLED');
CREATE TYPE "MediaAssetKind" AS ENUM ('PROFILE_PHOTO', 'VEHICLE_PHOTO', 'DOCUMENT', 'SELFIE', 'LISTING_PHOTO');
CREATE TYPE "MediaAssetStatus" AS ENUM ('PENDING', 'ACTIVE', 'DELETED');

ALTER TABLE "User"
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);

CREATE TABLE "VerificationCode" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "targetType" "VerificationCodeTargetType" NOT NULL,
  "targetValue" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "VerificationCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Booking" (
  "id" TEXT NOT NULL,
  "listingId" TEXT NOT NULL,
  "vehicleId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "renterId" TEXT NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3) NOT NULL,
  "status" "BookingStatus" NOT NULL DEFAULT 'REQUESTED',
  "pricePerDaySnapshot" DOUBLE PRECISION NOT NULL,
  "totalPriceSnapshot" DOUBLE PRECISION NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'ARS',
  "pickupTokenHash" TEXT,
  "returnTokenHash" TEXT,
  "pickupTokenPreview" TEXT,
  "returnTokenPreview" TEXT,
  "pickupConfirmedAt" TIMESTAMP(3),
  "returnConfirmedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "cancellationReason" TEXT,
  "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  "paymentProvider" TEXT,
  "providerPaymentId" TEXT,
  "platformFeeSnapshot" DOUBLE PRECISION,
  "depositSnapshot" DOUBLE PRECISION,
  "paidAt" TIMESTAMP(3),
  "refundedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentRecord" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT,
  "userId" TEXT,
  "status" "PaymentRecordStatus" NOT NULL DEFAULT 'MOCK',
  "provider" TEXT,
  "providerId" TEXT,
  "amount" DOUBLE PRECISION,
  "currency" TEXT NOT NULL DEFAULT 'ARS',
  "metadata" JSONB,
  "paidAt" TIMESTAMP(3),
  "refundedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MediaAsset" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "entityType" TEXT,
  "entityId" TEXT,
  "kind" "MediaAssetKind" NOT NULL,
  "url" TEXT NOT NULL,
  "storageProvider" TEXT,
  "storageKey" TEXT,
  "mimeType" TEXT,
  "sizeBytes" INTEGER,
  "status" "MediaAssetStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL,
  "actorId" TEXT,
  "targetUserId" TEXT,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VerificationCode_userId_targetType_consumedAt_idx" ON "VerificationCode"("userId", "targetType", "consumedAt");
CREATE INDEX "VerificationCode_expiresAt_idx" ON "VerificationCode"("expiresAt");
CREATE INDEX "Booking_listingId_idx" ON "Booking"("listingId");
CREATE INDEX "Booking_vehicleId_idx" ON "Booking"("vehicleId");
CREATE INDEX "Booking_ownerId_idx" ON "Booking"("ownerId");
CREATE INDEX "Booking_renterId_idx" ON "Booking"("renterId");
CREATE INDEX "Booking_status_idx" ON "Booking"("status");
CREATE INDEX "Booking_startDate_endDate_idx" ON "Booking"("startDate", "endDate");
CREATE INDEX "PaymentRecord_bookingId_idx" ON "PaymentRecord"("bookingId");
CREATE INDEX "PaymentRecord_userId_idx" ON "PaymentRecord"("userId");
CREATE INDEX "PaymentRecord_status_idx" ON "PaymentRecord"("status");
CREATE INDEX "MediaAsset_ownerId_idx" ON "MediaAsset"("ownerId");
CREATE INDEX "MediaAsset_entityType_entityId_idx" ON "MediaAsset"("entityType", "entityId");
CREATE INDEX "MediaAsset_kind_idx" ON "MediaAsset"("kind");
CREATE INDEX "MediaAsset_status_idx" ON "MediaAsset"("status");
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");
CREATE INDEX "AuditLog_targetUserId_idx" ON "AuditLog"("targetUserId");
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

ALTER TABLE "VerificationCode" ADD CONSTRAINT "VerificationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_renterId_fkey" FOREIGN KEY ("renterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
