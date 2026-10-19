-- La portada del perfil: el dibujo y el color que elige cada persona.
--
-- Dos columnas opcionales. Una cuenta que nunca haya elegido nada las tiene en
-- NULL y el front dibuja la portada de siempre, así que no hay nada que
-- completar para atrás.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profileCoverDesign" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profileCoverColor" TEXT;
