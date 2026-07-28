-- CreateEnum
CREATE TYPE "VehicleCategory" AS ENUM ('SEDAN', 'SUV', 'BERLINA', 'PICKUP', 'ELECTRIC', 'PREMIUM', 'OTHER');

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "category" "VehicleCategory";

-- CreateIndex
CREATE INDEX "Vehicle_category_idx" ON "Vehicle"("category");

-- CreateTable
CREATE TABLE "Favorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_userId_listingId_key" ON "Favorite"("userId", "listingId");

-- CreateIndex
CREATE INDEX "Favorite_userId_createdAt_idx" ON "Favorite"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Favorite_listingId_idx" ON "Favorite"("listingId");

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: los vehículos que ya estaban publicados no tienen categoría. Se
-- deduce de los datos que sí cargaron (eléctrico por combustible, pickup/SUV
-- por tamaño y asientos) para que el filtro por categoría no los deje afuera.
UPDATE "Vehicle" SET "category" = 'ELECTRIC' WHERE "category" IS NULL AND "fuelType" = 'ELECTRIC';
UPDATE "Vehicle" SET "category" = 'PICKUP' WHERE "category" IS NULL AND "drivetrain" = 'FOUR_BY_FOUR' AND COALESCE("lengthMm", 0) >= 4900;
UPDATE "Vehicle" SET "category" = 'SUV' WHERE "category" IS NULL AND (COALESCE("seats", 0) >= 7 OR COALESCE("heightMm", 0) >= 1650);
UPDATE "Vehicle" SET "category" = 'SEDAN' WHERE "category" IS NULL;
