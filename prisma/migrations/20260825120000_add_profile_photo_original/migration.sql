-- La foto de perfil sin recortar.
--
-- Columna nueva y nullable: las cuentas que ya existen quedan en NULL, que es
-- exactamente lo que corresponde —de esas fotos solo se guardó el recorte, la
-- original no existe en ninguna parte— y el front sabe caer al recorte cuando
-- no hay original.
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
    SELECT 1 FROM information_schema.tables WHERE table_name = 'User'
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS "profilePhotoOriginalUrl" TEXT;
END $$;
