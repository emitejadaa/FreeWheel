-- Categoría de los vehículos que ya estaban publicados antes de que la columna
-- existiera. Sin esto quedan con category = NULL y el filtro por categoría de la
-- home no los muestra nunca.
--
-- Se deduce de los datos que sí se cargaron: eléctrico por el combustible,
-- pickup por tracción y largo, SUV por asientos o altura, y el resto sedán.
-- Solo toca las filas en NULL, así que se puede correr todas las veces que sea
-- (lo ejecuta el deploy) sin pisar lo que el dueño del auto haya elegido.
UPDATE "Vehicle" SET "category" = 'ELECTRIC' WHERE "category" IS NULL AND "fuelType" = 'ELECTRIC';
UPDATE "Vehicle" SET "category" = 'PICKUP' WHERE "category" IS NULL AND "drivetrain" = 'FOUR_BY_FOUR' AND COALESCE("lengthMm", 0) >= 4900;
UPDATE "Vehicle" SET "category" = 'SUV' WHERE "category" IS NULL AND (COALESCE("seats", 0) >= 7 OR COALESCE("heightMm", 0) >= 1650);
UPDATE "Vehicle" SET "category" = 'SEDAN' WHERE "category" IS NULL;
