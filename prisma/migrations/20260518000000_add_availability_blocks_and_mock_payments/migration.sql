-- Add manual availability blocks for listings.
CREATE TABLE "ListingAvailabilityBlock" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingAvailabilityBlock_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ListingAvailabilityBlock_listingId_startDate_endDate_idx" ON "ListingAvailabilityBlock"("listingId", "startDate", "endDate");
CREATE INDEX "ListingAvailabilityBlock_ownerId_idx" ON "ListingAvailabilityBlock"("ownerId");

ALTER TABLE "ListingAvailabilityBlock"
ADD CONSTRAINT "ListingAvailabilityBlock_listingId_fkey"
FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ListingAvailabilityBlock"
ADD CONSTRAINT "ListingAvailabilityBlock_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
