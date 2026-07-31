-- Fotos o documentos que se suben como PRUEBA de un reporte.
--
-- Un reporte sin evidencia es la palabra de uno contra la del otro, y deja al
-- admin sin nada con que decidir si pausar una publicación o suspender una
-- cuenta. Ahora hace falta al menos una.
--
-- Con IF NOT EXISTS para poder aplicarse sobre una base que ya tenga el cambio
-- (ver la nota de las migraciones anteriores: la base la administra otra persona
-- y el deploy puede sincronizarla con `db push`).
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "evidenceUrls" TEXT[];
