-- Categoría de los vehículos que ya estaban publicados antes de que la columna
-- existiera. Sin esto quedan con category = NULL y el filtro por categoría de la
-- home no los muestra nunca.
--
-- Se deduce de los datos que sí se cargaron. El orden importa: cada UPDATE toca
-- solo lo que quedó en NULL, así que la regla de arriba gana sobre la de abajo.
--
-- Estas son las MISMAS reglas que inferCategory() en el front
-- (src/services/listings.js). Tienen que coincidir: si no, el mismo auto queda
-- en una categoría en la base y en otra en la pantalla.
--   · eléctrico   → por el combustible, antes que cualquier carrocería
--   · pickup      → 4x4 y 4,90 m o más de largo
--   · van         → 7 asientos o más
--   · SUV         → 1,55 m de alto o más (un SUV compacto anda en 1,56-1,59; el
--                   umbral viejo de 1,65 los dejaba clasificados como autos
--                   chicos)
--   · coupé       → dos puertas y menos de 1,45 m de alto
--   · hatchback   → menos de 4,25 m de largo (el largo que separa un Gol de un
--                   Corolla). Es el tipo más común del parque argentino y antes
--                   caía todo en sedán.
--   · sedán       → lo que queda
--
-- Solo toca las filas en NULL, así que se puede correr todas las veces que sea
-- (lo ejecuta el deploy) sin pisar lo que el dueño del auto haya elegido.
UPDATE "Vehicle" SET "category" = 'ELECTRIC' WHERE "category" IS NULL AND "fuelType" = 'ELECTRIC';
UPDATE "Vehicle" SET "category" = 'PICKUP' WHERE "category" IS NULL AND "drivetrain" = 'FOUR_BY_FOUR' AND COALESCE("lengthMm", 0) >= 4900;
UPDATE "Vehicle" SET "category" = 'VAN' WHERE "category" IS NULL AND COALESCE("seats", 0) >= 7;
UPDATE "Vehicle" SET "category" = 'SUV' WHERE "category" IS NULL AND COALESCE("heightMm", 0) >= 1550;
UPDATE "Vehicle" SET "category" = 'COUPE' WHERE "category" IS NULL AND COALESCE("doors", 0) = 2 AND COALESCE("heightMm", 0) BETWEEN 1 AND 1449;
UPDATE "Vehicle" SET "category" = 'HATCHBACK' WHERE "category" IS NULL AND COALESCE("lengthMm", 0) BETWEEN 1 AND 4249;
UPDATE "Vehicle" SET "category" = 'SEDAN' WHERE "category" IS NULL;
