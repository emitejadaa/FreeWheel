-- Las señales de que una cuenta está inflando su reputación, y las fotos de
-- las reseñas.
--
-- La reputación es lo único que hace que un desconocido le preste su auto a
-- otro. Si se puede fabricar —tres cuentas que se alquilan entre ellas y se
-- dejan cinco estrellas— todo lo demás da igual.
--
-- Es una tabla y no un cálculo al vuelo porque el panel tiene que poder marcar
-- una señal como revisada: calculada en el momento, la misma volvería a
-- aparecer todos los días aunque alguien ya la haya mirado, y una bandeja que
-- repite lo ya resuelto se deja de leer en una semana.
CREATE TABLE IF NOT EXISTS "FraudSignal" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "kind"           TEXT NOT NULL,
  "detail"         JSONB NOT NULL,
  "autoSuspended"  BOOLEAN NOT NULL DEFAULT false,
  "resolvedById"   TEXT,
  "resolvedAt"     TIMESTAMP(3),
  "resolutionNote" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FraudSignal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FraudSignal_userId_createdAt_idx" ON "FraudSignal"("userId", "createdAt");
-- La bandeja del panel lee por acá: las que todavía nadie resolvió.
CREATE INDEX IF NOT EXISTS "FraudSignal_resolvedAt_idx" ON "FraudSignal"("resolvedAt");

DO $$
BEGIN
  ALTER TABLE "FraudSignal" ADD CONSTRAINT "FraudSignal_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- La cuenta de quien resolvió se pone en NULL si esa cuenta se borra: perder al
-- administrador no puede llevarse puesto el registro de lo que decidió.
DO $$
BEGIN
  ALTER TABLE "FraudSignal" ADD CONSTRAINT "FraudSignal_resolvedById_fkey"
    FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Hasta dos fotos por reseña. Una foto del auto como quedó vale mucho más que
-- cinco estrellas, y de paso encarece inflar un perfil: escribir "todo bien" es
-- gratis, sacar y subir fotos distintas cada vez no tanto.
ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "photos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
