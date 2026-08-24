-- Las características de una reseña.
--
-- Es una columna nueva, con valor por defecto y NOT NULL: las reseñas que ya
-- existen quedan con la lista vacía, que es exactamente lo que corresponde
-- —nadie eligió ninguna característica cuando no había ninguna que elegir— y
-- ninguna consulta anterior se rompe.
--
-- Se escribe con IF NOT EXISTS porque scripts/deploy-migrate.js puede haber
-- llegado antes por el camino de `prisma db push`, que agrega la columna sin
-- anotar nada en el historial. En ese caso esta migración no tiene que fallar:
-- tiene que no hacer nada.
DO $$
BEGIN
  -- Base recién creada (todavía sin tablas): el push que viene después la va a
  -- crear ya con la columna puesta.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'Review'
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE "Review"
    ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
END $$;
