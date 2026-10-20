-- Dónde se recorta la foto de portada.
--
-- La portada es una franja ancha y baja, y la foto se achica hasta llenarla:
-- siempre sobra imagen por algún lado y el navegador, por su cuenta, recorta
-- por el centro. Con una foto en la que el motivo está arriba —una persona, un
-- cartel, el techo de un auto— el centro es justamente lo que no hay que
-- mostrar, y la portada queda cortada sin que su dueño pueda hacer nada.
--
-- Dos enteros de 0 a 100 y no un texto con la posición de CSS ya armada: un
-- texto terminaría metido adentro de una propiedad de estilo. En NULL van al
-- medio, que es como se veía antes.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profileCoverX" INTEGER;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profileCoverY" INTEGER;
