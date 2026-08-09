-- Dos cosas en una migración: quién ve la foto de perfil, y las carrocerías
-- deportivas que reemplazan a "Premium".
--
-- ── 1. PhotoVisibility ───────────────────────────────────────────────────────
-- Una foto de perfil es una cara. Antes había una sola respuesta posible —la
-- foto se veía siempre, aunque en la práctica casi no se veía en ninguna
-- parte— y quien no estuviera de acuerdo no tenía más opción que no subir
-- ninguna. Ahora se elige: la ve todo el mundo, o solo la gente con la que hay
-- una reserva en común.
--
-- El valor por defecto es EVERYONE porque es lo que espera quien sube una foto,
-- y porque así ninguna cuenta que ya tenía foto cambia de comportamiento al
-- aplicar esta migración.
--
-- ── 2. COUPE y CONVERTIBLE ───────────────────────────────────────────────────
-- "Premium" no es un tipo de auto: es una opinión sobre el precio. No dice si el
-- auto tiene dos puertas o cinco, ni si entra una familia. Y un particular no
-- alquila un deportivo de colección, así que la categoría estaba vacía y ocupaba
-- lugar. Se reemplaza por las dos carrocerías reales de un auto deportivo:
--   · COUPE       → dos puertas, techo fijo
--   · CONVERTIBLE → dos puertas, techo rebatible
--
-- PREMIUM no se borra del enum: hay publicaciones que ya lo usan y Postgres no
-- deja quitar un valor de un enum sin reescribir la columna. Se deja de ofrecer
-- al publicar; el front deduce la carrocería de esos autos por sus medidas, así
-- que siguen apareciendo en los filtros.
--
-- Idempotente a propósito: la base la administra otra persona y el deploy puede
-- sincronizarla con `db push` en vez de con la cadena de migraciones, así que
-- esto tiene que poder correr dos veces sin fallar.

-- El tipo del enum nuevo. CREATE TYPE no admite IF NOT EXISTS, de ahí el bloque.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PhotoVisibility') THEN
    CREATE TYPE "PhotoVisibility" AS ENUM ('EVERYONE', 'BOOKED');
  END IF;
END $$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "profilePhotoVisibility" "PhotoVisibility" NOT NULL DEFAULT 'EVERYONE';

-- Los dos valores nuevos de VehicleCategory.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'VehicleCategory' AND e.enumlabel = 'COUPE'
  ) THEN
    ALTER TYPE "VehicleCategory" ADD VALUE 'COUPE';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'VehicleCategory' AND e.enumlabel = 'CONVERTIBLE'
  ) THEN
    ALTER TYPE "VehicleCategory" ADD VALUE 'CONVERTIBLE';
  END IF;
END $$;
