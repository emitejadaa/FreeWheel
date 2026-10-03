-- Cuántas veces se le preguntó cada cosa al asistente, en todo el sitio.
--
-- Una fila por pregunta, no una por vez que se preguntó: lo único que se quiere
-- es ordenar los cuatro botones de preguntas sugeridas. No se guarda quién
-- preguntó ni qué escribió.
--
-- Va con IF NOT EXISTS, como el resto de las migraciones de este repo, para que
-- aplicarla dos veces no falle.

CREATE TABLE IF NOT EXISTS "AssistantQuestionCount" (
    "questionId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "lastAskedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantQuestionCount_pkey" PRIMARY KEY ("questionId")
);

CREATE INDEX IF NOT EXISTS "AssistantQuestionCount_count_idx"
    ON "AssistantQuestionCount"("count");
