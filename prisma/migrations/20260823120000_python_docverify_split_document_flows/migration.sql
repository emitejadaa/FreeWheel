-- Verificación documental con el verificador Python: flujos separados de DNI
-- y licencia. Reemplaza la tabla UserVerification (submissions de 4 fotos con
-- revisión por proveedor de visión) por DocumentVerification (una fila viva
-- por documento y usuario).
--
-- Escrita idempotente como el resto de las migraciones del proyecto: la base
-- puede haber sido sincronizada con `db push`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VerifiedDocumentType') THEN
    CREATE TYPE "VerifiedDocumentType" AS ENUM ('DNI', 'LICENSE');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DocumentVerificationStatus') THEN
    CREATE TYPE "DocumentVerificationStatus" AS ENUM ('APPROVED', 'FAILED', 'MANUAL_REVIEW', 'REJECTED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "DocumentVerification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "VerifiedDocumentType" NOT NULL,
  "status" "DocumentVerificationStatus" NOT NULL,
  "frontUrl" TEXT,
  "backUrl" TEXT,
  "documentNumber" TEXT,
  "expiresAt" TIMESTAMP(3),
  "extracted" JSONB,
  "matchReport" JSONB,
  "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "reviewRequestedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DocumentVerification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DocumentVerification_userId_type_key" ON "DocumentVerification"("userId", "type");
CREATE INDEX IF NOT EXISTS "DocumentVerification_status_idx" ON "DocumentVerification"("status");
CREATE INDEX IF NOT EXISTS "DocumentVerification_documentNumber_idx" ON "DocumentVerification"("documentNumber");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DocumentVerification_userId_fkey'
  ) THEN
    ALTER TABLE "DocumentVerification"
      ADD CONSTRAINT "DocumentVerification_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- El sistema anterior queda sin rastros: la tabla de submissions con las
-- URLs de 4 fotos y los veredictos del proveedor de visión ya no se usa.
DROP TABLE IF EXISTS "UserVerification";
