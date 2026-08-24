-- 003_account_identity_unique.sql — Un dato único, una sola cuenta
--
-- Deja la base en condiciones de sostener la unicidad de la identidad de una
-- cuenta: email sin mayúsculas y teléfono sin repetir. Corre ANTES de
-- `migrate deploy` y de `db push`, que es lo que hace posible que `db push`
-- pueda crear el índice único de "phone": con dos cuentas usando el mismo
-- número, crearlo falla y la base se queda sin actualizar.
--
-- Es idempotente y pregunta antes de tocar nada —incluso si la tabla todavía no
-- existe—: puede correr en todos los deploys, para siempre.
DO $$
BEGIN
  -- Base recién creada (todavía sin tablas): no hay nada que ordenar y el push
  -- que viene después las va a crear ya con las reglas puestas.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'User'
  ) THEN
    RETURN;
  END IF;

  -- ── 1. Los emails, todos en minúsculas ────────────────────────────────────
  -- El índice único de "email" compara texto tal cual: para Postgres
  -- 'Ana@Gmail.com' y 'ana@gmail.com' son dos valores distintos y convivían como
  -- DOS CUENTAS, aunque el correo llegue a la misma casilla. Pasando todo a
  -- minúsculas, el índice único que ya existe pasa a valer también para las
  -- mayúsculas.
  --
  -- El row_number() está porque dos filas del mismo grupo ('A@x.com' y
  -- 'a@X.com') querrían las dos el mismo valor final y chocarían entre ellas: se
  -- normaliza la más vieja del grupo y nada más. El NOT EXISTS cubre el otro
  -- caso: que el valor en minúsculas ya sea de otra cuenta.
  --
  -- Lo que queda sin normalizar son cuentas duplicadas de verdad, y hay que
  -- decidir a mano cuál sobrevive. Se pueden ver con:
  --   SELECT id, email FROM "User" WHERE email <> lower(btrim(email));
  -- y borrar la que sobra desde el panel (DELETE /admin/users/:id).
  WITH objetivo AS (
    SELECT
      "id",
      lower(btrim("email")) AS normalizado,
      row_number() OVER (
        PARTITION BY lower(btrim("email")) ORDER BY "createdAt", "id"
      ) AS orden
    FROM "User"
  )
  UPDATE "User" u
  SET "email" = o.normalizado
  FROM objetivo o
  WHERE u."id" = o."id"
    AND o.orden = 1
    AND u."email" <> o.normalizado
    AND NOT EXISTS (
      SELECT 1 FROM "User" otro
      WHERE otro."id" <> u."id" AND otro."email" = o.normalizado
    );

  -- ── 2. Un teléfono, una cuenta ────────────────────────────────────────────
  -- "phone" pasa a ser único, así que los repetidos que ya estén cargados hay
  -- que resolverlos ANTES o el índice no se puede crear —y si no se puede crear,
  -- `db push` corta y la base se queda sin actualizar—. Se queda con el número
  -- la cuenta más vieja (la que lo usó primero) y las demás quedan sin teléfono,
  -- con la verificación del número dada de baja: tenerla marcada sin número
  -- sería decir que se verificó algo que ya no está.
  --
  -- Esas cuentas pueden volver a cargar un teléfono; el único que no van a poder
  -- poner es justamente el que era de otra persona.
  WITH repetidos AS (
    SELECT
      "id",
      row_number() OVER (PARTITION BY "phone" ORDER BY "createdAt", "id") AS orden
    FROM "User"
    WHERE "phone" IS NOT NULL
  )
  UPDATE "User" u
  SET "phone" = NULL, "phoneVerifiedAt" = NULL
  FROM repetidos r
  WHERE u."id" = r."id" AND r.orden > 1;

  -- ── 3. Que no vuelva a entrar un email con mayúsculas ─────────────────────
  -- Sin esto, el paso 1 arregla lo que ya estaba pero no impide que mañana entre
  -- 'Ana@Gmail.com' de nuevo. Y no alcanza con la unicidad: si una dirección se
  -- guardara con mayúsculas, la búsqueda por email (que compara exacto, contra
  -- el índice único) no la encontraría y esa persona no podría iniciar sesión ni
  -- recuperar la contraseña.
  --
  -- Es un CHECK y no un índice a propósito: lo que hay que garantizar es que el
  -- dato GUARDADO sea el canónico, no solo que no se repita.
  --
  -- Se agrega solo si no quedan filas que lo violen (ver el paso 1): si quedaron
  -- duplicados sin resolver, esto no corre y el deploy sigue igual. Se vuelve a
  -- intentar en el próximo deploy, cuando ya se hayan borrado a mano.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_email_lowercase_check'
  ) AND NOT EXISTS (
    SELECT 1 FROM "User" WHERE "email" <> lower(btrim("email"))
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_email_lowercase_check"
      CHECK ("email" = lower(btrim("email")));
  END IF;

  -- ── 4. Unicidad del email sin mirar mayúsculas, a nivel base ──────────────
  -- El CHECK de arriba más el índice único de "email" ya alcanzan mientras el
  -- CHECK esté puesto. Este índice lo sostiene igual si el CHECK no se pudo
  -- agregar (duplicados pendientes), y hace que el choque salga como P2002 —el
  -- error que la API traduce a un 409 con "ya hay una cuenta con ese email"— en
  -- vez de un error crudo de constraint.
  --
  -- Prisma no sabe expresar un índice por expresión en el schema, así que se
  -- crea acá. Comprobado: `prisma db push` no lo borra (no lo ve en la
  -- introspección).
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'User' AND indexname = 'User_email_lower_key'
  ) AND NOT EXISTS (
    SELECT lower(btrim("email")) FROM "User"
    GROUP BY lower(btrim("email")) HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (lower(btrim("email")));
  END IF;
END $$;
