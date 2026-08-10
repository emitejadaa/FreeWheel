-- Tipos de auto que faltaban: HATCHBACK y VAN.
--
-- POR QUÉ: la lista era SEDAN, SUV, BERLINA, PICKUP, ELECTRIC, PREMIUM. Tenía
-- dos problemas.
--
--  1. BERLINA y SEDAN son lo MISMO: "berlina" es la palabra castellana (e
--     italiana) para sedán. Eran dos tarjetas distintas para el mismo tipo de
--     auto, así que quien publicaba tenía que adivinar en cuál de las dos poner
--     su Corolla, y quien buscaba se perdía la mitad de los autos según cuál
--     hubiera elegido el dueño.
--
--  2. Faltaba HATCHBACK, que en Argentina es el tipo MÁS común (Yaris, Gol,
--     Onix, Argo). No tenerlo obligaba a cargarlos como sedán, que es otra cosa.
--
-- BERLINA no se borra del enum: hay publicaciones que ya lo usan y Postgres no
-- deja quitar un valor de un enum sin reescribir la columna. Se deja de ofrecer
-- en el front y se muestra como "Sedán", que es lo que siempre fue. Si alguna
-- vez se quiere limpiar de verdad, primero hay que pasar esas filas a SEDAN.
--
-- Idempotente a propósito: la base la administra otra persona y el deploy puede
-- sincronizarla con `db push` en vez de con la cadena de migraciones, así que
-- esto tiene que poder correr dos veces sin fallar.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'VehicleCategory' AND e.enumlabel = 'HATCHBACK'
  ) THEN
    ALTER TYPE "VehicleCategory" ADD VALUE 'HATCHBACK';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'VehicleCategory' AND e.enumlabel = 'VAN'
  ) THEN
    ALTER TYPE "VehicleCategory" ADD VALUE 'VAN';
  END IF;
END $$;
