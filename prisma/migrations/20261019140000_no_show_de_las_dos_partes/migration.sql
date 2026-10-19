-- Las dos constancias del retiro que no pasó, y la decisión cuando chocan.
--
-- Hasta acá solo el dueño podía dejar constancia ("esta persona no apareció").
-- Quien alquilaba no tenía dónde decir lo mismo del dueño: su única salida era
-- cancelar, y la cancelación no distingue entre "me arrepentí" y "estuve media
-- hora esperando en la esquina".
--
-- Con las dos, de las cuatro combinaciones posibles tres se resuelven solas y
-- la cuarta —las dos partes acusándose— queda trabada a propósito, con las dos
-- versiones y sus horas, hasta que alguien decida. Esa decisión va en
-- noShowResolvedFor y NO borra la constancia que pierde: un dueño al que se le
-- caen los reclamos una y otra vez es un patrón que hay que poder ver.
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "ownerNoShowAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "noShowResolvedFor" TEXT;
