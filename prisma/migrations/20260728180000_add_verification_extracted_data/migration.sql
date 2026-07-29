-- Datos que la revisión automática lee de los documentos (número de DNI, nombre
-- tal como figura y vencimiento de la licencia) más quién hizo la revisión.
-- Quedan registrados en la base en vez de depender de lo que escriba el usuario.
--
-- Con IF NOT EXISTS para poder aplicarse sobre una base que ya tenga parte de
-- estos cambios (ver la nota de la migración anterior).
ALTER TABLE "UserVerification" ADD COLUMN IF NOT EXISTS "documentNumber" TEXT;
ALTER TABLE "UserVerification" ADD COLUMN IF NOT EXISTS "fullNameOnDocument" TEXT;
ALTER TABLE "UserVerification" ADD COLUMN IF NOT EXISTS "licenseExpiresAt" TIMESTAMP(3);
ALTER TABLE "UserVerification" ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;
