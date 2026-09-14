-- Lectura automática de documentos y habilitación para conducir.
--
-- Dos cosas nuevas que van juntas porque una alimenta a la otra:
--
--   1. DocumentVerification guarda en qué anda la lectura automática y qué
--      sacó de las fotos (`extracted`), para poder auditar después por qué una
--      cuenta quedó aprobada.
--   2. User guarda lo que esa lectura descubrió y que nadie había cargado a
--      mano: el vencimiento de la licencia, su clase y el período de
--      principiante. Son los campos que deciden, en cada pedido, si esta
--      persona puede alquilar un auto.
--
-- Escrita idempotente como el resto de las migraciones del proyecto: la base
-- puede haber sido sincronizada con `db push`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DocumentAnalysisStatus') THEN
    CREATE TYPE "DocumentAnalysisStatus" AS ENUM ('NOT_REQUESTED', 'QUEUED', 'DONE', 'FAILED');
  END IF;
END $$;

ALTER TABLE "DocumentVerification"
  ADD COLUMN IF NOT EXISTS "extracted" JSONB,
  ADD COLUMN IF NOT EXISTS "analysisStatus" "DocumentAnalysisStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
  ADD COLUMN IF NOT EXISTS "analysisRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "analysisError" TEXT,
  ADD COLUMN IF NOT EXISTS "analysisTokenHash" TEXT;

-- El aviso de que un análisis terminó llega sin sesión: lo único que lo
-- identifica es el token, así que buscar por su hash es la consulta que hace
-- CADA callback. Único además de indexado: dos filas no pueden compartir token.
CREATE UNIQUE INDEX IF NOT EXISTS "DocumentVerification_analysisTokenHash_key"
  ON "DocumentVerification" ("analysisTokenHash");

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "licenseExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "licenseClass" TEXT,
  ADD COLUMN IF NOT EXISTS "licenseIssuedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "licenseBeginnerUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "dniExpiresAt" TIMESTAMP(3);
