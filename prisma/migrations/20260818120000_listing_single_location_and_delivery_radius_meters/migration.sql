-- Una publicación tiene UN solo punto.
--
-- Antes había dos: el del auto (latitude/longitude) y otro aparte para la
-- entrega (deliveryLatitude/deliveryLongitude). Nunca se usaron —ninguna
-- publicación los tiene cargados— y sobraban: lo que el dueño elige en el mapa
-- es dónde está el auto, y la entrega es un radio ALREDEDOR de ese mismo punto,
-- no un segundo lugar.
--
-- El radio pasa de kilómetros a metros: es la unidad del slider del front, y un
-- entero en metros evita que "5 km" y "5000 m" convivan como dos formas del
-- mismo dato.

-- Primero la columna nueva, para poder traer lo que hubiera cargado.
ALTER TABLE "Listing" ADD COLUMN "deliveryRadiusM" INTEGER NOT NULL DEFAULT 0;

UPDATE "Listing"
SET "deliveryRadiusM" = ROUND("deliveryRadiusKm" * 1000)
WHERE "deliveryRadiusKm" IS NOT NULL;

ALTER TABLE "Listing" DROP COLUMN "deliveryRadiusKm";
ALTER TABLE "Listing" DROP COLUMN "deliveryLatitude";
ALTER TABLE "Listing" DROP COLUMN "deliveryLongitude";
