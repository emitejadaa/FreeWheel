-- Identidad manual del perfil (debe coincidir con los documentos) + unicidad
-- antifraude: un mismo DNI/CUIL no puede respaldar dos cuentas.
ALTER TABLE "User" ADD COLUMN "dni" TEXT;
ALTER TABLE "User" ADD COLUMN "cuil" TEXT;
ALTER TABLE "User" ADD COLUMN "address" TEXT;

CREATE UNIQUE INDEX "User_dni_key" ON "User"("dni");
CREATE UNIQUE INDEX "User_cuil_key" ON "User"("cuil");

-- Resultado de la revision documental (reviewer document_ai): extraccion por
-- fuente y reporte de cruces check por check. Las columnas escalares
-- (documentNumber, fullNameOnDocument, licenseExpiresAt, reviewedBy) ya las
-- creo la migracion 20260728180000_add_verification_extracted_data.
ALTER TABLE "UserVerification" ADD COLUMN "extracted" JSONB;
ALTER TABLE "UserVerification" ADD COLUMN "matchReport" JSONB;

-- Antifraude: buscar si un documento ya verifico otra cuenta.
CREATE INDEX "UserVerification_documentNumber_idx" ON "UserVerification"("documentNumber");
