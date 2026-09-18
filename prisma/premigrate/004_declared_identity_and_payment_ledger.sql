-- LOS BORRADOS QUE `db push` NO HACE SOLO.
--
-- `db push` se niega a tocar una columna con datos adentro, y hace bien: un
-- --accept-data-loss automático en un deploy borra cosas que nadie miró. Lo que
-- corresponde es mover lo que haya que mover, dejar la columna vacía, y recién
-- ahí dejar que el push la saque.
--
-- Corre en TODOS los deploys, así que cada paso pregunta antes de tocar nada.

-- ── 1. El domicilio deja de ser un dato de la cuenta ────────────────────────
--
-- No se comparaba contra el documento, no habilitaba nada y era el dato más
-- sensible que guardábamos de una persona. La única dirección que el sistema
-- necesita es la del auto, y esa vive en Listing.locationText.
--
-- Se borra la columna entera en vez de vaciarla: una columna vacía que nadie
-- lee es una invitación a volver a llenarla.
ALTER TABLE "User" DROP COLUMN IF EXISTS "address";

-- ── 2. Lo que la lectura automática había sacado de las fotos ───────────────
--
-- `extracted` guardaba los valores leídos del DNI y la licencia: nombre,
-- número, fecha de nacimiento, clase. Ese dato ya no se guarda —la lectura
-- ahora solo COMPARA contra lo que la persona declaró— así que la columna se
-- va, y con ella los valores que quedaron de antes.
ALTER TABLE "DocumentVerification" DROP COLUMN IF EXISTS "extracted";

-- ── 3. Los vencimientos que había leído el OCR ──────────────────────────────
--
-- Quedaron en User escritos por la lectura automática, no declarados por su
-- dueño. Son justamente el dato que este cambio deja de tomar de la máquina: un
-- vencimiento mal leído dejaba a alguien verificado y sin poder reservar, sin
-- forma de corregirlo.
--
-- Se limpian SOLO los de las cuentas cuyo documento todavía no fue reenviado
-- bajo el flujo nuevo (las que no tienen datos declarados). La persona los
-- vuelve a cargar la próxima vez que envía el documento, que es cuando puede
-- leerlos con los ojos.
--
-- Vaciarlos no bloquea a nadie: un vencimiento desconocido no impide nada (ver
-- driving-eligibility.ts). Dejar el valor equivocado, en cambio, sí.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'DocumentVerification' AND column_name = 'declared'
  ) THEN
    UPDATE "User" u
    SET "licenseExpiresAt"     = NULL,
        "licenseClass"         = NULL,
        "licenseIssuedAt"      = NULL,
        "licenseBeginnerUntil" = NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM "DocumentVerification" d
      WHERE d."userId" = u.id AND d.type = 'LICENSE' AND d.declared IS NOT NULL
    );

    UPDATE "User" u
    SET "dniExpiresAt" = NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM "DocumentVerification" d
      WHERE d."userId" = u.id AND d.type = 'DNI' AND d.declared IS NOT NULL
    );
  END IF;
END $$;

-- ── 4. El número de documento vuelve a ser el declarado ─────────────────────
--
-- El control antifraude (una identidad no verifica dos cuentas) se apoyaba en
-- el número que había leído la foto. Ahora se apoya en el que declaró la
-- persona, corroborado por la foto. Las filas viejas se alinean con el perfil.
UPDATE "DocumentVerification" d
SET "documentNumber" = u.dni
FROM "User" u
WHERE d."userId" = u.id AND u.dni IS NOT NULL;
