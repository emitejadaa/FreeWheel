-- Cuándo el dueño dejó constancia de que la persona no apareció a retirar.
--
-- Pasada la hora acordada sin entrega confirmada, cancelar devuelve todo: el
-- que no aparece no cobra. Esta marca es lo único que lo cambia, porque dice
-- que el dueño sí fue.

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "renterNoShowAt" TIMESTAMP(3);
