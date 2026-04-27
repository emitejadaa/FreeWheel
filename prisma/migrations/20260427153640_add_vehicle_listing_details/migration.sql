-- CreateEnum
CREATE TYPE "DrivetrainType" AS ENUM ('REAR', 'FRONT', 'FOUR_BY_FOUR', 'AWD');

-- AlterTable
ALTER TABLE "Vehicle"
ADD COLUMN "drivetrain" "DrivetrainType",
ADD COLUMN "bluetooth" BOOLEAN,
ADD COLUMN "rearCamera" BOOLEAN,
ADD COLUMN "parkingSensors" BOOLEAN,
ADD COLUMN "fuelConsumptionLitersPer100Km" DOUBLE PRECISION,
ADD COLUMN "doors" INTEGER,
ADD COLUMN "trunkCapacityLiters" INTEGER,
ADD COLUMN "widthMm" INTEGER,
ADD COLUMN "lengthMm" INTEGER,
ADD COLUMN "heightMm" INTEGER,
ADD COLUMN "weightKg" INTEGER,
ADD COLUMN "observations" TEXT;

-- AlterTable
ALTER TABLE "Listing"
ADD COLUMN "deliveryLatitude" DOUBLE PRECISION,
ADD COLUMN "deliveryLongitude" DOUBLE PRECISION,
ADD COLUMN "deliveryRadiusKm" DOUBLE PRECISION;
