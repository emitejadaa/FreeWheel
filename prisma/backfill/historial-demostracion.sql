-- ===========================================================================
--  HISTORIAL DE DEMOSTRACIÓN DE LA CUENTA QUE SE PRESENTA
-- ---------------------------------------------------------------------------
--  PARA QUÉ EXISTE.
--
--  Freewheel se muestra con una cuenta real, y una cuenta real recién creada no
--  tiene historia: ningún alquiler terminado, ninguna reseña, y por lo tanto
--  ningún rango. La pantalla queda honesta y vacía a la vez, y lo que hay para
--  mostrar —la escalera de rangos, la planilla de reputación, las columnas con
--  los aspectos más votados, las reseñas— no se ve porque no hay con qué
--  llenarlo. Es como presentar un tablero sin datos: lo que se juzga no es el
--  tablero, es el vacío.
--
--  Esto carga ese historial. No pone un número a mano en una columna: arma las
--  filas que el número resume. Hay reservas terminadas de verdad, con sus
--  fechas y sus importes, y reseñas de verdad escritas sobre esas reservas. Los
--  promedios se calculan al final CONTANDO esas filas, así que la base queda
--  coherente consigo misma y la app no tiene que hacer ninguna excepción.
--
--  Esa es la diferencia que importa: un `ratingCount = 32` escrito a mano y una
--  lista de reseñas vacía se contradicen en la misma pantalla, y se nota.
--
--  ── QUÉ CARGA ──────────────────────────────────────────────────────────────
--   · 10 personas de demostración (dominio @freewheel.demo, que no existe).
--   · 1 auto y 1 publicación de una de ellas, para que la cuenta también pueda
--     haber alquilado y no solo prestado.
--   · 20 alquileres terminados sobre las publicaciones propias (como dueño) y
--     12 sobre la publicación de demostración (como conductor).
--   · Las reseñas de las dos puntas de cada uno de esos alquileres.
--   · Los promedios, recalculados contando lo anterior.
--
--  ── LAS TRES PRECAUCIONES ──────────────────────────────────────────────────
--
--  1. SE PUEDE CORRER MIL VECES. Lo ejecuta el deploy en cada publicación. Si
--     el historial ya está, sale sin tocar nada. Todos los identificadores
--     empiezan con "demo-", así que además se puede borrar entero de un saque.
--
--  2. NO SE CAE NUNCA. Si la cuenta no existe en esta base —otro deploy, otra
--     base— sale en silencio. Si no tiene ninguna publicación, carga solo la
--     mitad que no depende de eso. Un backfill que corta un deploy sería un
--     problema mucho más caro que el que vino a resolver.
--
--  3. LAS CUENTAS DE DEMOSTRACIÓN NO SON CUENTAS. Su contraseña no es un hash
--     de bcrypt sino un texto cualquiera, así que ninguna comparación va a dar
--     verdadera y no se puede entrar con ellas. Y tienen los avisos por mail
--     apagados, sobre un dominio inexistente: nunca sale un mail para nadie.
-- ===========================================================================
DO $$
DECLARE
  -- La cuenta que se presenta. Es el único dato de este archivo que hay que
  -- cambiar para apuntarlo a otra.
  CUENTA   CONSTANT TEXT := 'britosignacio106@gmail.com';
  COMO_DUENO   CONSTANT INT := 20;  -- alquileres en los que prestó su auto
  COMO_CONDUCTOR CONSTANT INT := 12;  -- alquileres en los que manejó

  yo        TEXT;
  publicadas INT;
BEGIN
  SELECT "id" INTO yo FROM "User" WHERE lower("email") = lower(CUENTA);
  IF yo IS NULL THEN
    RAISE NOTICE '[demo] No hay ninguna cuenta con ese mail en esta base: no se carga nada.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM "Booking" WHERE "id" LIKE 'demo-alq-%') THEN
    RAISE NOTICE '[demo] El historial ya estaba cargado.';
    RETURN;
  END IF;

  -- ── Las personas ────────────────────────────────────────────────────────
  -- Nombres comunes y apellidos comunes: son los que aparecen firmando las
  -- reseñas, y un "Usuario 03" se lee como lo que es.
  INSERT INTO "User" ("id","email","password","firstName","lastName",
                      "emailNotifications","verificationStatus","status","updatedAt")
  VALUES
    ('demo-persona-01','demo01@freewheel.demo','sin-acceso','Lucía','Fernández',false,'VERIFIED','ACTIVE',now()),
    ('demo-persona-02','demo02@freewheel.demo','sin-acceso','Martín','Gómez',false,'VERIFIED','ACTIVE',now()),
    ('demo-persona-03','demo03@freewheel.demo','sin-acceso','Sofía','Ramírez',false,'VERIFIED','ACTIVE',now()),
    ('demo-persona-04','demo04@freewheel.demo','sin-acceso','Tomás','Benítez',false,'VERIFIED','ACTIVE',now()),
    ('demo-persona-05','demo05@freewheel.demo','sin-acceso','Camila','Ruiz',false,'VERIFIED','ACTIVE',now()),
    ('demo-persona-06','demo06@freewheel.demo','sin-acceso','Nicolás','Sosa',false,'VERIFIED','ACTIVE',now()),
    ('demo-persona-07','demo07@freewheel.demo','sin-acceso','Valentina','Acosta',false,'VERIFIED','ACTIVE',now()),
    ('demo-persona-08','demo08@freewheel.demo','sin-acceso','Julián','Medina',false,'VERIFIED','ACTIVE',now()),
    ('demo-persona-09','demo09@freewheel.demo','sin-acceso','Agustina','Herrera',false,'VERIFIED','ACTIVE',now()),
    ('demo-persona-10','demo10@freewheel.demo','sin-acceso','Franco','Vera',false,'VERIFIED','ACTIVE',now())
  ON CONFLICT ("id") DO NOTHING;

  -- ── El auto que alquiló esta cuenta ─────────────────────────────────────
  -- Es de una de las personas de demostración. Sin esto, la cuenta figuraría
  -- solo como dueña y la mitad "como conductor" de la planilla quedaría vacía.
  INSERT INTO "Vehicle" ("id","ownerId","brand","model","year","category","seats",
                         "doors","transmission","fuelType","updatedAt")
  VALUES ('demo-auto-01','demo-persona-01','Toyota','Corolla',2021,'SEDAN',5,5,
          'AUTOMATIC','GASOLINE',now())
  ON CONFLICT ("id") DO NOTHING;

  INSERT INTO "Listing" ("id","vehicleId","ownerId","title","description",
                         "pricePerDay","locationText","latitude","longitude",
                         "status","updatedAt")
  VALUES ('demo-aviso-01','demo-auto-01','demo-persona-01',
          'Toyota Corolla 2021',
          'Automático, nafta, muy cómodo para viajar. Service al día.',
          46000,'Av. Rivadavia 5000, Caballito',-34.6187,-58.4408,'ACTIVE',now())
  ON CONFLICT ("id") DO NOTHING;

  -- ── Los alquileres en los que prestó su auto ────────────────────────────
  SELECT count(*) INTO publicadas FROM "Listing" WHERE "ownerId" = yo;

  IF publicadas = 0 THEN
    RAISE NOTICE '[demo] La cuenta no tiene publicaciones: se carga solo el historial como conductor.';
  ELSE
    /*
      Se reparten en orden entre las publicaciones propias, y van hacia atrás
      en el tiempo de a once días: el más reciente terminó la semana pasada y
      el más viejo hace unos siete meses. Que las fechas sean creíbles importa,
      porque se muestran.
    */
    INSERT INTO "Booking" (
      "id","listingId","vehicleId","ownerId","renterId",
      "startDate","endDate","status","pricePerDaySnapshot","totalPriceSnapshot",
      "currency","paymentStatus","pickupConfirmedAt","returnConfirmedAt",
      "platformFeeSnapshot","ownerPayoutSnapshot","createdAt","updatedAt")
    SELECT
      'demo-alq-d-' || lpad(n::text, 2, '0'),
      a."id", a."vehicleId", yo,
      'demo-persona-' || lpad((((n - 1) % 10) + 1)::text, 2, '0'),
      (now() - ((n * 11 + 4) || ' days')::interval),
      (now() - ((n * 11) || ' days')::interval),
      'COMPLETED', a."pricePerDay", a."pricePerDay" * 4,
      'ARS', 'PAID',
      (now() - ((n * 11 + 4) || ' days')::interval),
      (now() - ((n * 11) || ' days')::interval),
      round((a."pricePerDay" * 4 * 0.1)::numeric, 2),
      round((a."pricePerDay" * 4 * 0.9)::numeric, 2),
      (now() - ((n * 11 + 9) || ' days')::interval),
      now()
    FROM generate_series(1, COMO_DUENO) AS n
    JOIN (
      SELECT "id", "vehicleId", "pricePerDay",
             row_number() OVER (ORDER BY "createdAt", "id") AS k
      FROM "Listing" WHERE "ownerId" = yo
    ) a ON a.k = ((n - 1) % publicadas) + 1
    ON CONFLICT ("id") DO NOTHING;
  END IF;

  -- ── Los alquileres en los que manejó ────────────────────────────────────
  INSERT INTO "Booking" (
    "id","listingId","vehicleId","ownerId","renterId",
    "startDate","endDate","status","pricePerDaySnapshot","totalPriceSnapshot",
    "currency","paymentStatus","pickupConfirmedAt","returnConfirmedAt",
    "platformFeeSnapshot","ownerPayoutSnapshot","createdAt","updatedAt")
  SELECT
    'demo-alq-c-' || lpad(n::text, 2, '0'),
    'demo-aviso-01','demo-auto-01','demo-persona-01', yo,
    (now() - ((n * 17 + 3) || ' days')::interval),
    (now() - ((n * 17) || ' days')::interval),
    'COMPLETED', 46000, 46000 * 3,
    'ARS', 'PAID',
    (now() - ((n * 17 + 3) || ' days')::interval),
    (now() - ((n * 17) || ' days')::interval),
    13800, 124200,
    (now() - ((n * 17 + 8) || ' days')::interval),
    now()
  FROM generate_series(1, COMO_CONDUCTOR) AS n
  ON CONFLICT ("id") DO NOTHING;

  -- ── Lo que le escribieron ───────────────────────────────────────────────
  /*
    Las que recibió COMO DUEÑO las escribe quien alquiló, y llevan la
    publicación cargada: son las que hablan del auto y cuentan para la
    puntuación del aviso. Las características son del grupo que se le puede
    poner a un dueño (ver src/reviews/review-tags.ts); mandar una de las otras
    dejaría el conteo del perfil diciendo cualquier cosa.

    Una de cada ocho es de cuatro estrellas. Treinta y dos reseñas de cinco
    perfectas no las tiene nadie, y lo que se quiere mostrar es una reputación
    buena, no una inventada.
  */
  INSERT INTO "Review" ("id","bookingId","authorId","targetUserId","listingId",
                        "rating","comment","tags","createdAt","updatedAt")
  SELECT
    'demo-res-d-' || right(b."id", 2),
    b."id", b."renterId", yo, b."listingId",
    CASE WHEN (right(b."id", 2))::int % 8 = 0 THEN 4 ELSE 5 END,
    (ARRAY[
      'Todo perfecto. El auto estaba impecable y la entrega fue rapidísima.',
      'Muy buena experiencia, contestó todos los mensajes al toque.',
      'El auto tal cual las fotos. Lo recomiendo.',
      'Súper prolijo con la entrega y con la devolución. Repetiría.',
      'Muy amable y puntual. El auto andaba bárbaro.',
      'Clarísimo con todo desde el primer mensaje. Cero vueltas.',
      'Me lo entregó limpio y con el tanque lleno. Diez puntos.',
      'Buena onda y muy flexible con los horarios.'
    ])[((right(b."id", 2))::int % 8) + 1],
    -- Un CASE y no una lista de listas: en Postgres, indexar un arreglo de
    -- arreglos devuelve un elemento suelto y no la fila entera, así que
    -- ARRAY[ARRAY[...], ...][n] no da lo que parece.
    CASE (right(b."id", 2))::int % 8
      WHEN 0 THEN ARRAY['AUTO_COMO_LA_FOTO','AUTO_LIMPIO','RESPONDE_RAPIDO']
      WHEN 1 THEN ARRAY['RESPONDE_RAPIDO','TRATO_AMABLE']
      WHEN 2 THEN ARRAY['AUTO_COMO_LA_FOTO','PUNTUAL']
      WHEN 3 THEN ARRAY['AUTO_LIMPIO','SIN_COBROS_EXTRA','TRATO_AMABLE']
      WHEN 4 THEN ARRAY['PUNTUAL','TRATO_AMABLE']
      WHEN 5 THEN ARRAY['RESPONDE_RAPIDO','SIN_COBROS_EXTRA']
      WHEN 6 THEN ARRAY['AUTO_LIMPIO','AUTO_COMO_LA_FOTO']
      ELSE        ARRAY['TRATO_AMABLE','PUNTUAL','RESPONDE_RAPIDO']
    END,
    b."returnConfirmedAt" + interval '1 day', now()
  FROM "Booking" b
  WHERE b."id" LIKE 'demo-alq-d-%'
  ON CONFLICT ("bookingId","authorId") DO NOTHING;

  /*
    Las que recibió COMO CONDUCTOR las escribe el dueño del auto que alquiló, y
    van SIN publicación: hablan de la persona, no del aviso, y cargarlas con la
    publicación le subiría la puntuación a un auto que no es suyo.
  */
  INSERT INTO "Review" ("id","bookingId","authorId","targetUserId","listingId",
                        "rating","comment","tags","createdAt","updatedAt")
  SELECT
    'demo-res-c-' || right(b."id", 2),
    b."id", 'demo-persona-01', yo, NULL,
    CASE WHEN (right(b."id", 2))::int % 8 = 0 THEN 4 ELSE 5 END,
    (ARRAY[
      'Devolvió el auto impecable y a horario. Un lujo.',
      'Cuidó el auto como si fuera suyo. Lo alquilo de nuevo cuando quiera.',
      'Muy respetuoso con los horarios y con el auto.',
      'Todo perfecto, avisó cada cosa. Recomendadísimo.'
    ])[((right(b."id", 2))::int % 4) + 1],
    CASE (right(b."id", 2))::int % 4
      WHEN 0 THEN ARRAY['CUIDO_EL_AUTO','DEVOLVIO_LIMPIO','PUNTUAL']
      WHEN 1 THEN ARRAY['CUIDO_EL_AUTO','TRATO_AMABLE']
      WHEN 2 THEN ARRAY['PUNTUAL','DEVOLVIO_LIMPIO']
      ELSE        ARRAY['RESPONDE_RAPIDO','CUIDO_EL_AUTO','TRATO_AMABLE']
    END,
    b."returnConfirmedAt" + interval '1 day', now()
  FROM "Booking" b
  WHERE b."id" LIKE 'demo-alq-c-%'
  ON CONFLICT ("bookingId","authorId") DO NOTHING;

  /*
    Y LAS QUE ESCRIBIÓ ELLA.

    No son decoración: sin esto, las treinta y dos reservas le quedarían
    figurando como "pendientes de reseñar" en su propia pantalla, que es
    exactamente el cartel que no queremos que aparezca el día de la
    presentación. Una reserva terminada en la que las dos partes ya se
    calificaron está CERRADA, y eso es lo que se quiere mostrar.
  */
  INSERT INTO "Review" ("id","bookingId","authorId","targetUserId","listingId",
                        "rating","comment","tags","createdAt","updatedAt")
  SELECT
    'demo-res-m-' || right(b."id", 4),
    b."id", yo,
    CASE WHEN b."ownerId" = yo THEN b."renterId" ELSE b."ownerId" END,
    CASE WHEN b."ownerId" = yo THEN NULL ELSE b."listingId" END,
    5,
    CASE WHEN b."ownerId" = yo
      THEN 'Todo bien, cuidó el auto y lo devolvió en horario.'
      ELSE 'Muy buena atención y el auto en excelente estado.' END,
    CASE WHEN b."ownerId" = yo
      THEN ARRAY['CUIDO_EL_AUTO','DEVOLVIO_LIMPIO','PUNTUAL']
      ELSE ARRAY['AUTO_COMO_LA_FOTO','AUTO_LIMPIO','TRATO_AMABLE'] END,
    b."returnConfirmedAt" + interval '2 days', now()
  FROM "Booking" b
  WHERE b."id" LIKE 'demo-alq-%'
  ON CONFLICT ("bookingId","authorId") DO NOTHING;

  -- ── Los promedios, CONTANDO lo de arriba ────────────────────────────────
  -- Se calculan, no se escriben a mano. Si mañana se borra una reseña y se
  -- vuelve a correr esto, el promedio sigue siendo el de las filas que hay.
  UPDATE "User" u
  SET "ratingAverage" = s.promedio, "ratingCount" = s.cantidad
  FROM (
    SELECT "targetUserId" AS uid,
           round(avg("rating")::numeric, 2)::float8 AS promedio,
           count(*)::int AS cantidad
    FROM "Review" GROUP BY "targetUserId"
  ) s
  WHERE u."id" = s.uid;

  UPDATE "Listing" l
  SET "ratingAverage" = s.promedio, "ratingCount" = s.cantidad
  FROM (
    SELECT "listingId" AS lid,
           round(avg("rating")::numeric, 2)::float8 AS promedio,
           count(*)::int AS cantidad
    FROM "Review" WHERE "listingId" IS NOT NULL GROUP BY "listingId"
  ) s
  WHERE l."id" = s.lid;

  RAISE NOTICE '[demo] Historial cargado para %.', CUENTA;
END $$;
