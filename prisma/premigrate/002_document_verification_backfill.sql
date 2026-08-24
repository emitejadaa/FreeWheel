-- ─────────────────────────────────────────────────────────────────────────────
-- De UserVerification (una fila con las 4 fotos) a DocumentVerification
-- (una fila viva por documento y usuario).
--
-- POR QUÉ ESTE ARCHIVO EXISTE
-- El schema nuevo ya no tiene UserVerification, así que `db push` quiere
-- borrarla. Con filas adentro se niega —bien negado— y el deploy termina con
-- la API nueva publicada contra una base vieja: 500 en todo lo que toque
-- DocumentVerification. Fue exactamente lo que pasó en el deploy 82b4b64:
--
--     You are about to drop the `UserVerification` table, which is not empty
--     (4 rows). Error: Use the --accept-data-loss flag ...
--
-- Un --accept-data-loss habría "arreglado" el deploy borrando verificaciones
-- de cuentas reales. Lo que corresponde es mover el dato primero y recién
-- entonces dejar que el push encuentre la tabla vacía.
--
-- CÓMO SE TRADUCE CADA ESTADO
--   VERIFIED     → el DNI y la licencia se aprobaban JUNTOS, así que salen dos
--                  filas APPROVED (una por documento). La cuenta sigue
--                  verificada.
--   ID_SUBMITTED → estaba esperando un veredicto: pasa a MANUAL_REVIEW, con
--                  las fotos intactas, para que lo resuelva un admin. Nada se
--                  aprueba solo.
--   REJECTED     → REJECTED, y las URLs se anulan como hace el flujo nuevo.
--
-- Un usuario podía tener varias filas (se creaba una por envío): se toma la
-- más concluyente (VERIFIED antes que REJECTED antes que pendiente) y, a
-- igualdad, la más reciente. Solo se migran los documentos que tenían al menos
-- una foto cargada.
--
-- El JSON viejo (`extracted`, `matchReport`) tiene otra forma que la del
-- sistema nuevo: se conserva entero en `extracted` para poder mirarlo, y
-- `matchReport` queda en NULL para no alimentar la vista de admin con una
-- estructura que no entiende.
--
-- Corre en todos los deploys: si la tabla vieja ya no está, no hace nada.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VerifiedDocumentType') THEN
    CREATE TYPE "VerifiedDocumentType" AS ENUM ('DNI', 'LICENSE');
  END IF;
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DocumentVerification_userId_fkey') THEN
    ALTER TABLE "DocumentVerification"
      ADD CONSTRAINT "DocumentVerification_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'UserVerification'
  ) THEN
    RAISE NOTICE 'UserVerification ya no existe: no hay nada que migrar.';
    RETURN;
  END IF;

  -- Una sola fila por usuario: la más concluyente y, a igualdad, la más nueva.
  CREATE TEMP TABLE _origen ON COMMIT DROP AS
  SELECT DISTINCT ON ("userId") *
  FROM "UserVerification"
  ORDER BY
    "userId",
    CASE "status"::text
      WHEN 'VERIFIED' THEN 0
      WHEN 'REJECTED' THEN 1
      ELSE 2
    END,
    "createdAt" DESC;

  INSERT INTO "DocumentVerification" (
    "id", "userId", "type", "status", "frontUrl", "backUrl", "documentNumber",
    "expiresAt", "extracted", "reasonCodes", "reviewedBy", "reviewedAt",
    "notes", "createdAt", "updatedAt"
  )
  SELECT
    gen_random_uuid()::text,
    o."userId",
    doc.tipo::"VerifiedDocumentType",
    (CASE o."status"::text
       WHEN 'VERIFIED' THEN 'APPROVED'
       WHEN 'REJECTED' THEN 'REJECTED'
       ELSE 'MANUAL_REVIEW'
     END)::"DocumentVerificationStatus",
    CASE WHEN o."status"::text = 'REJECTED' THEN NULL ELSE doc.frente END,
    CASE WHEN o."status"::text = 'REJECTED' THEN NULL ELSE doc.dorso END,
    o."documentNumber",
    CASE WHEN doc.tipo = 'LICENSE' THEN o."licenseExpiresAt" END,
    o."extracted",
    ARRAY[]::TEXT[],
    o."reviewedBy",
    o."reviewedAt",
    COALESCE(o."notes" || ' · ', '') || 'Migrado del sistema de verificación anterior.',
    o."createdAt",
    NOW()
  FROM _origen o
  CROSS JOIN LATERAL (
    VALUES
      ('DNI',     o."dniFrontUrl",     o."dniBackUrl"),
      ('LICENSE', o."licenseFrontUrl", o."licenseBackUrl")
  ) AS doc(tipo, frente, dorso)
  WHERE doc.frente IS NOT NULL OR doc.dorso IS NOT NULL
  ON CONFLICT ("userId", "type") DO NOTHING;

  RAISE NOTICE 'Backfill de DocumentVerification completo.';
END $$;

-- Ya no queda nada adentro que perder: se saca acá para que `db push` no
-- tenga que decidir sobre una tabla con datos.
DROP TABLE IF EXISTS "UserVerification";
