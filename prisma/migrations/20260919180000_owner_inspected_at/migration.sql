-- Cuándo el dueño revisó el auto devuelto.
--
-- Cierra la ventana de revisión antes de tiempo y es lo que hace que el botón
-- de revisar desaparezca. Sin esta marca la pantalla no tenía forma de saber
-- que el dueño ya había mirado el auto.

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "ownerInspectedAt" TIMESTAMP(3);
