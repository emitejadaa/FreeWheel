-- Los nombres que quedaron escritos en minúscula.
--
-- A partir de ahora el nombre y el apellido se guardan con la mayúscula puesta
-- (ver src/common/utils/name.util.ts), pero las cuentas que ya existían quedaron
-- como se cargaron: "ignacio britos" en el perfil, en el chat, en la ficha que
-- mira la otra persona antes de prestarle su auto, y en todos los mails.
--
-- ── SOLO TOCA LO QUE ESTÁ ENTERO EN MINÚSCULA ──────────────────────────────
-- Es la misma precaución que toma el código, y es la que hace que esto se pueda
-- correr sin mirar: si el texto tiene UNA sola mayúscula en cualquier posición,
-- su dueño lo escribió así —"McDonald", "DiCaprio", "O'Brien"— y no se toca.
-- "Corregir" un apellido ajeno es peor que el problema que se vino a resolver.
--
-- initcap pone en mayúscula la primera letra de cada palabra, así que
-- "juan carlos" queda "Juan Carlos" y no "Juan carlos".
--
-- Es idempotente: después de pasar, las filas ya no están en minúscula y la
-- condición no las vuelve a elegir. Lo corre el deploy en cada publicación.
UPDATE "User"
SET "firstName" = initcap("firstName")
WHERE "firstName" = lower("firstName") AND "firstName" <> initcap("firstName");

UPDATE "User"
SET "lastName" = initcap("lastName")
WHERE "lastName" = lower("lastName") AND "lastName" <> initcap("lastName");

-- El nombre para mostrar, cuando lo hay. Es el que gana en todas las pantallas
-- cuando está cargado, así que arreglar los otros dos y dejar este en minúscula
-- no habría cambiado nada de lo que se ve.
UPDATE "User"
SET "displayName" = initcap("displayName")
WHERE "displayName" IS NOT NULL
  AND "displayName" = lower("displayName")
  AND "displayName" <> initcap("displayName");
