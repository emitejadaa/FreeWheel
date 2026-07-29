-- Datos que la revisión automática lee de los documentos (número de DNI, nombre
-- tal como figura y vencimiento de la licencia) más quién hizo la revisión.
-- Quedan registrados en la base en vez de depender de lo que escriba el usuario.
ALTER TABLE "UserVerification" ADD COLUMN     "documentNumber" TEXT,
ADD COLUMN     "fullNameOnDocument" TEXT,
ADD COLUMN     "licenseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT;
