-- El dueño decide en qué orden van las fotos de su auto.
--
-- POR QUÉ. La primera foto es la portada: es la que se ve en el buscador, en el
-- inicio, en el globo del mapa y en "Mis autos". Hasta ahora el orden era el de
-- subida, o sea el que salió del explorador de archivos al elegirlas: nadie lo
-- decidió. Cambiar la portada obligaba a borrar la publicación y cargarla de
-- nuevo, con las reseñas y el historial que eso se lleva puesto.
--
-- NINGUNA PUBLICACIÓN QUE YA EXISTE CAMBIA. La columna arranca en 0 para todas,
-- así que quedan empatadas, y la consulta desempata por createdAt —que era el
-- criterio anterior—. El orden que ve la gente hoy es el mismo mañana; recién
-- cambia cuando el dueño lo cambia a propósito.
--
-- POR QUÉ NO ES NULL. Con NULL habría que decidir en cada consulta si va
-- primero o último, y cada motor lo ordena distinto. Con 0 y NOT NULL la
-- comparación es siempre la misma cuenta.
--
-- EL ÍNDICE. Las fotos de un auto se piden por (entityType, entityId) —ya hay
-- índice para eso— y se ordenan por position. Se agrega el índice que junta las
-- tres cosas para que el orden salga leído del índice y no de ordenar en
-- memoria: en el buscador esto se pide para todos los autos de la página a la
-- vez, así que es la consulta más caliente que toca esta tabla.
ALTER TABLE "MediaAsset" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "MediaAsset_entityType_entityId_position_idx"
  ON "MediaAsset" ("entityType", "entityId", "position");
