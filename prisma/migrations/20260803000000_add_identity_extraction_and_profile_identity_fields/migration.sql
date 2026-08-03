-- Identidad manual del perfil (debe coincidir con los documentos) + unicidad
-- antifraude: un mismo DNI/CUIL no puede respaldar dos cuentas.
ALTER TABLE "User" ADD COLUMN "dni" TEXT;
ALTER TABLE "User" ADD COLUMN "cuil" TEXT;
ALTER TABLE "User" ADD COLUMN "address" TEXT;

CREATE UNIQUE INDEX "User_dni_key" ON "User"("dni");
CREATE UNIQUE INDEX "User_cuil_key" ON "User"("cuil");

-- Resultado de la revision documental automatica (reviewer document_ai).
ALTER TABLE "UserVerification" ADD COLUMN "extracted" JSONB;
ALTER TABLE "UserVerification" ADD COLUMN "matchReport" JSONB;
ALTER TABLE "UserVerification" ADD COLUMN "dniNumber" TEXT;
ALTER TABLE "UserVerification" ADD COLUMN "licenseExpiresAt" TIMESTAMP(3);
ALTER TABLE "UserVerification" ADD COLUMN "reviewerName" TEXT;

CREATE INDEX "UserVerification_dniNumber_idx" ON "UserVerification"("dniNumber");
