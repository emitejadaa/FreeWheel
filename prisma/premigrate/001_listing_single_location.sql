-- Pasar las publicaciones al modelo de un solo punto + radio en metros.
--
-- Esto no lo puede hacer `db push` solo: para llegar al schema nuevo tiene que
-- BORRAR tres columnas, y si alguna tiene datos se niega (con razón). Así que el
-- traspaso se hace acá, a mano y sin perder nada, y después el push ya no
-- encuentra nada que borrar.
--
-- Tiene que poder correr en TODOS los deploys, no sólo en el primero: cada paso
-- pregunta antes si hace falta.

DO $$
DECLARE
  rescatadas INT := 0;
BEGIN
  -- Base recién creada: todavía no hay tabla que arreglar. La crea el push que
  -- viene después, ya con la forma nueva.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'Listing'
  ) THEN
    RETURN;
  END IF;

  -- 1. La columna nueva.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Listing' AND column_name = 'deliveryRadiusM'
  ) THEN
    ALTER TABLE "Listing" ADD COLUMN "deliveryRadiusM" INTEGER NOT NULL DEFAULT 0;
    RAISE NOTICE '[premigrate] Listing.deliveryRadiusM creada.';
  END IF;

  -- 2. El radio que estuviera cargado en kilómetros pasa a metros.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Listing' AND column_name = 'deliveryRadiusKm'
  ) THEN
    EXECUTE '
      UPDATE "Listing"
      SET "deliveryRadiusM" = LEAST(ROUND("deliveryRadiusKm" * 1000), 200000)
      WHERE "deliveryRadiusKm" IS NOT NULL AND "deliveryRadiusM" = 0';
    GET DIAGNOSTICS rescatadas = ROW_COUNT;
    RAISE NOTICE '[premigrate] % publicaciones con radio pasado a metros.', rescatadas;

    EXECUTE 'ALTER TABLE "Listing" DROP COLUMN "deliveryRadiusKm"';
  END IF;

  -- 3. El punto de entrega separado desaparece. Antes de borrarlo: si la
  --    publicación NO tiene coordenada propia, la del punto de entrega es la
  --    única que tiene, así que pasa a ser la suya. Sin esto, esa publicación
  --    quedaría sin ubicación y fuera de cualquier búsqueda por zona.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Listing' AND column_name = 'deliveryLatitude'
  ) THEN
    EXECUTE '
      UPDATE "Listing"
      SET latitude = "deliveryLatitude", longitude = "deliveryLongitude"
      WHERE latitude IS NULL
        AND longitude IS NULL
        AND "deliveryLatitude" IS NOT NULL
        AND "deliveryLongitude" IS NOT NULL';
    GET DIAGNOSTICS rescatadas = ROW_COUNT;
    RAISE NOTICE '[premigrate] % publicaciones sin coordenada tomaron la del punto de entrega.', rescatadas;

    EXECUTE 'ALTER TABLE "Listing" DROP COLUMN "deliveryLatitude"';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Listing' AND column_name = 'deliveryLongitude'
  ) THEN
    EXECUTE 'ALTER TABLE "Listing" DROP COLUMN "deliveryLongitude"';
  END IF;
END $$;
