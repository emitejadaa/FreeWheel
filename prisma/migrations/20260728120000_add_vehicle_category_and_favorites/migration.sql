-- Categoría de vehículo (para que el filtro de la home funcione) y tabla de
-- favoritos.
--
-- Todo está escrito para poder correrse dos veces sin romperse (IF NOT EXISTS y
-- guardas). La base de este proyecto la administra otra persona y no se sabe con
-- certeza si algún cambio ya se aplicó a mano o con `prisma db push`; así la
-- migración funciona igual en cualquiera de los dos casos.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VehicleCategory') THEN
    CREATE TYPE "VehicleCategory" AS ENUM ('SEDAN', 'SUV', 'BERLINA', 'PICKUP', 'ELECTRIC', 'PREMIUM', 'OTHER');
  END IF;
END $$;

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "category" "VehicleCategory";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_category_idx" ON "Vehicle"("category");

-- CreateTable
CREATE TABLE IF NOT EXISTS "Favorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Favorite_userId_listingId_key" ON "Favorite"("userId", "listingId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Favorite_userId_createdAt_idx" ON "Favorite"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Favorite_listingId_idx" ON "Favorite"("listingId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Favorite_userId_fkey') THEN
    ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Favorite_listingId_fkey') THEN
    ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill: los vehículos que ya estaban publicados no tienen categoría. Se
-- deduce de los datos que sí cargaron (eléctrico por combustible, pickup/SUV
-- por tamaño y asientos) para que el filtro por categoría no los deje afuera.
UPDATE "Vehicle" SET "category" = 'ELECTRIC' WHERE "category" IS NULL AND "fuelType" = 'ELECTRIC';
UPDATE "Vehicle" SET "category" = 'PICKUP' WHERE "category" IS NULL AND "drivetrain" = 'FOUR_BY_FOUR' AND COALESCE("lengthMm", 0) >= 4900;
UPDATE "Vehicle" SET "category" = 'SUV' WHERE "category" IS NULL AND (COALESCE("seats", 0) >= 7 OR COALESCE("heightMm", 0) >= 1650);
UPDATE "Vehicle" SET "category" = 'SEDAN' WHERE "category" IS NULL;
