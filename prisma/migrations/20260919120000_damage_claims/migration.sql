-- El reclamo de un daño del dueño sobre el depósito en garantía.
--
-- El depósito deja de liberarse en el momento en que se confirma la devolución:
-- queda retenido mientras el dueño tiene la ventana para revisar el auto. Sin
-- esa ventana un reclamo llegaría siempre tarde, porque la retención ya estaría
-- soltada y no habría nada que capturar.
--
-- Va con IF NOT EXISTS en todo: esta base se creó con `db push` y el deploy
-- puede elegir cualquiera de los dos caminos (ver scripts/deploy-migrate.js).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DamageClaimStatus') THEN
    CREATE TYPE "DamageClaimStatus" AS ENUM ('OPEN', 'ACCEPTED', 'REJECTED');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "DamageClaim" (
  "id"                  TEXT NOT NULL,
  "bookingId"           TEXT NOT NULL,
  "ownerId"             TEXT NOT NULL,
  "description"         TEXT NOT NULL,
  "claimedAmountMinor"  INTEGER NOT NULL,
  "evidenceUrls"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"              "DamageClaimStatus" NOT NULL DEFAULT 'OPEN',
  "resolvedById"        TEXT,
  "resolvedAt"          TIMESTAMP(3),
  "resolutionNote"      TEXT,
  "capturedAmountMinor" INTEGER,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DamageClaim_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DamageClaim_status_createdAt_idx" ON "DamageClaim" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "DamageClaim_bookingId_idx" ON "DamageClaim" ("bookingId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DamageClaim_bookingId_fkey') THEN
    ALTER TABLE "DamageClaim" ADD CONSTRAINT "DamageClaim_bookingId_fkey"
      FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DamageClaim_ownerId_fkey') THEN
    ALTER TABLE "DamageClaim" ADD CONSTRAINT "DamageClaim_ownerId_fkey"
      FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DamageClaim_resolvedById_fkey') THEN
    ALTER TABLE "DamageClaim" ADD CONSTRAINT "DamageClaim_resolvedById_fkey"
      FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
