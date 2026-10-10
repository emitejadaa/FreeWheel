# FreeWheel Backend

Backend NestJS de un marketplace de alquiler de autos entre personas: cuentas y
verificación de identidad, vehículos y publicaciones, disponibilidad, reservas
con contrato digital, cobros con Stripe (modo de prueba) y un libro contable de
partida doble, reclamos por daños, reseñas, denuncias, chat y un asistente de IA.

Corre como Nest/Express local y como función serverless en Vercel
(`api/index.ts`). El estado de producción y los riesgos conocidos están en
[`docs/PRODUCTION_READINESS_AUDIT.md`](docs/PRODUCTION_READINESS_AUDIT.md); la
referencia larga por módulo, en `backend.md`.

## Stack

- NestJS 11 sobre Express, TypeScript estricto
- Prisma 6 + PostgreSQL (Neon en remoto)
- JWT (`@nestjs/jwt`, `passport-jwt`, HS256 fijo) y Google OAuth opcional
- class-validator / class-transformer (`ValidationPipe` global con whitelist)
- Stripe (solo claves de prueba), Cloudinary, Gmail SMTP, Twilio opcional, Groq
- Servicio aparte en Python para leer documentos: [`docverify-api/`](docverify-api/)
- Jest (unitarios en `src/**/*.spec.ts`, e2e en `test/*.e2e-spec.ts`)

## Estructura

```txt
api/index.ts                 Entrada serverless de Vercel
src/main.ts                  Entrada local / proceso largo
src/app.factory.ts           Express + Nest compartido (helmet, CORS, parsers, arranque perezoso)
src/cors.config.ts           CORS con lista blanca y modos strict / report-only / open
src/common                   Guards, decoradores, filtros de error, rate limit, cifrado, utils
src/config                   JWT y URLs públicas
src/auth, src/users          Registro en dos pasos, login, OAuth, sesiones, perfil
src/verification             Códigos de email/teléfono y verificación de DNI y licencia
src/vehicles, src/vehicle-verification   Autos y verificación de titularidad
src/listings, src/availability            Publicaciones, precio con confirmación, calendario
src/bookings                 Reservas, códigos QR de entrega/devolución, política de cancelación
src/payments, src/ledger     Cobros (Stripe/mock), webhook, liquidación, libro de partida doble
src/contracts                Contrato por reserva (PDF, aceptación con IP y navegador)
src/claims                   Reclamos por daños durante la ventana de inspección
src/reviews, src/reports     Reseñas y denuncias (con revisión por IA)
src/favorites, src/conversations   Favoritos y chat entre las partes
src/media                    Firmas de subida a Cloudinary y registro de assets
src/ai                       Proxy de Groq (chat, visión, transcripción)
src/email, src/sms           Mails transaccionales y SMS
src/admin                    Panel de administración
src/retention, src/jobs      Purga de datos personales y trabajo diario (cron)
src/health                   /health, /health/db, /health/env
prisma/                      schema, migraciones, premigrate y backfills
scripts/                     Migración en deploy, checks y herramientas locales
test/                        Suite e2e contra una base descartable
docverify-api/               Lector de documentos (Python, deploy aparte)
```

## Variables De Entorno

Crear `.env` desde `.env.example`, que tiene la lista completa comentada. No
commitear secretos reales.

Obligatorias:

```env
DATABASE_URL="postgresql://user:password@host:5432/freewheel?sslmode=require"
JWT_SECRET="..."   # openssl rand -base64 48
```

En producción la API **no arranca** sin un `JWT_SECRET` propio (vacío, de
ejemplo o de menos de 16 caracteres). Fuera de producción usa uno de desarrollo.

Las más importantes del resto:

| Variable | Para qué |
| --- | --- |
| `JWT_EXPIRES_IN` | Vida del token de sesión (por omisión `7d`). |
| `FRONTEND_URL`, `API_BASE_URL` | Links de los mails, redirección de Google y callbacks. En Vercel la URL de la API sale de `VERCEL_URL`. |
| `CORS_ORIGINS`, `CORS_STRICT`, `DEMO_ORIGINS` | Ver "CORS" abajo. |
| `DATA_ENCRYPTION_KEY` | Cifrado de campos (32 bytes en base64). En producción, sin ella lo que se cifra contesta 503. |
| `CRON_SECRET` | Autentica `GET /internal/cron/daily`. Sin ella el cron no corre. |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Cobros. Solo se aceptan claves de prueba. |
| `PAYMENTS_PROVIDER` | `stripe` (por omisión) o `mock` (solo tests; en producción no arranca). |
| `CLOUDINARY_*` | Fotos y documentos. |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Mails. Sin ellas no se puede registrar ni recuperar la contraseña. |
| `DOCVERIFY_URL`, `DOCVERIFY_TOKEN` | Lectura automática de documentos. Sin ellas los documentos los revisa un admin. |
| `GROQ_API_KEY` | Chatbot, revisión de fotos de autos y transcripción. |
| `ADMIN_EMAILS` | Cuentas que se promueven a ADMIN al arrancar (con el mail confirmado). |

`GET /health/env` dice qué está cargado en un deploy (solo nombres y sí/no).

### CORS

`src/cors.config.ts` tiene tres modos. `CORS_STRICT=true` rechaza todo origen
fuera de la lista (`CORS_ORIGINS`, o si no está, `FRONTEND_URL` + `PUBLIC_URL` +
los puertos de desarrollo + las vistas previas `*.vercel.app`). Sin
`CORS_STRICT`, producción queda en **report-only** (deja pasar y loguea "pasaría
a rechazar …") y desarrollo en **open**. El token viaja en `Authorization`, no
en cookies; lo que protege la lista son sobre todo las rutas públicas que gastan
cuota (el chat de IA).

## Instalacion Y Desarrollo

```bash
npm install          # postinstall: prisma generate (+ migración solo en Vercel)
npm run start:dev    # http://localhost:3000
```

## Deploy En Vercel

`vercel.json` reescribe todo a la función `api/index.ts` (60 s máximo), corre
`npm run build` y programa el cron diario (`/internal/cron/daily`, 06:00 UTC).

La base se actualiza durante el deploy desde el `postinstall`
(`scripts/deploy-migrate.js`, solo con `VERCEL` o `--force`): corre
`prisma/premigrate/*.sql`, después `prisma migrate deploy` si la base tiene
historial de migraciones o `prisma db push` si se creó sin él (el historial no
arranca de cero), y el backfill de categorías. Si falla no frena el deploy:
lo deja escrito en el log y `GET /health/db` dice qué falta. A mano:
`npm run db:migrate:prod`.

## Prisma

Modelos principales: `User`, `Vehicle` y `VehicleVerification`, `Listing`,
`ListingAvailabilityBlock`, `Booking`, `Contract`/`ContractAcceptance`,
`PaymentRecord`/`PaymentEvent` (cada cobro y su historial append-only),
`StripeEvent` (dedup de webhooks), `LedgerJournal`/`LedgerEntry` (libro de
partida doble), `DamageClaim`, `DocumentVerification`, `VerificationCode`,
`PendingRegistration`, `MediaAsset`, `Conversation`/`Message`, `Review`,
`Report`, `Favorite`, `AuditLog`, `RateLimitBucket`.

```bash
npm run check:prisma
npx prisma migrate dev
npm run db:migrate:deploy
```

No usar migraciones destructivas ni `db push --accept-data-loss` contra
producción sin confirmación explícita.

## Endpoints

La lista completa, lista para disparar, está en el `.rest` de cada módulo. Por
grupo (JWT = sesión; "verificada" = cuenta VERIFIED, `@RequireVerifiedAccount`):

- **Públicos:** `GET /`, `GET /health`, `/health/db`, `/health/env`,
  `GET /listings`, `GET /listings/:id`, `GET /listings/:id/availability`,
  `GET /vehicles/:id`, reseñas y reputación (`GET /listings/:id/reviews`,
  `GET /users/:id/reviews`, `GET /users/:id/reputation`), `GET /payments/config`,
  `POST /ai/chat`, `GET /ai/health`, `/ai/questions/*`, el registro y el login de
  `/auth/*`, `POST /payments/stripe/webhook` (firma de Stripe) y
  `POST /verification/identity/analysis-callback` (token de un solo uso).
- **Cuenta:** `/users/me`, `GET /users/:id` (perfil público), `/auth/verify-email`,
  `/auth/complete-profile`, `/auth/request-email-change`,
  `/auth/confirm-email-change`, `/verification/*` (códigos y documentos),
  `/favorites`, `/conversations`, `/media/*`, `/reports`, `/reviews/me/pending`,
  `/ai/vision`, `/ai/transcribe`.
- **Operación (verificada):** alta y edición de `/vehicles` y `/listings`
  (incluye fotos, bloqueos de calendario y cambio de precio con código por
  mail), `/vehicles/:id/verification`, `/bookings` (pedir, aceptar, rechazar,
  cancelar, listo para retirar, confirmar retiro y devolución, liquidar),
  `/contracts/bookings/:id/accept`, `/payments/bookings/:id/*` (checkout,
  depósito, estado, ticket, historial), `/payments/connect/*`, reclamos por
  daños (`/bookings/:id/damage-claim`, `/damage-claims/:id/*`).
- **Admin:** `/admin/*` (usuarios, verificaciones, publicaciones, reservas,
  reclamos, denuncias, verificaciones de autos), `/payments/admin/ledger/*`,
  `POST /payments/bookings/:id/deposit-capture` y `/settle`.
- **Interno:** `GET /internal/cron/daily` (`Authorization: Bearer $CRON_SECRET`).

### Sacar una cuenta de circulacion: borrarla o darla de baja

Son dos cosas distintas y la diferencia esta en que pasa con **los datos** de la
cuenta (email, telefono, DNI, CUIL):

| | `PATCH /admin/users/:id/status` (SUSPENDED / DELETED) | `DELETE /admin/users/:id` |
| --- | --- | --- |
| **La cuenta** | No puede iniciar sesion, ni por email ni por Google; los tokens que ya tenia dejan de valer | Deja de existir |
| **Sus datos unicos** (email, telefono, DNI, CUIL) | **Quedan tomados**: nadie puede registrarse de nuevo con ellos | **Quedan libres** para volver a usarse |
| **Sus publicaciones** | Se dan de baja (status `DELETED`): fuera del buscador y del detalle | Se borran |
| **Sus autos** | Se conservan | Se borran |
| **Sus imagenes en Cloudinary** (fotos y documentos) | **Se conservan** — la cuenta sigue existiendo y los documentos son la prueba del caso | **Se borran** |
| **Reservas, contratos y pagos** (que involucran a otras personas) | Se conservan | Se borran |
| **Donde se puede** | Siempre | Solo fuera de produccion |

Reactivar una cuenta suspendida **no devuelve sus publicaciones**: un aviso dado
de baja no se distingue de uno que el dueno borro por su cuenta. El auto sigue
estando, asi que se vuelve a publicar.

En produccion `DELETE /admin/users/:id` contesta `403
ACCOUNT_HARD_DELETE_DISABLED`. Es a proposito: si se borrara la cuenta de quien
fue expulsado, esa persona podria volver a registrarse con el mismo mail, el
mismo telefono y el mismo documento. El borrado existe para el desarrollo, donde
hace falta reciclar los datos de las cuentas de demostracion. El panel se entera
de si esta habilitado con `GET /admin/settings`.

Se puede forzar en cualquiera de los dos sentidos con `ALLOW_ACCOUNT_HARD_DELETE`
(`true` / `false`); sin esa variable, el borrado esta habilitado en todos lados
menos en produccion.

## Probar La API (archivos `.rest`)

Cada modulo de `src/` tiene su propio `<modulo>.rest` (extension **REST
Client** de VS Code, `humao.rest-client`) con todos sus endpoints listos para
dispararse y probar cada flujo de punta a punta a mano — por ejemplo
`src/auth/auth.rest`, `src/bookings/bookings.rest`, `src/payments/payments.rest`,
etc. `baseUrl` sale de `.vscode/settings.json` (elegir entorno `local` o
`production` con "Switch Environment" en VS Code). Cada archivo se autocontiene:
arranca registrando la(s) cuenta(s) de prueba que necesita y encadena tokens/ids
con `# @name` + `{{request.response.body.$.campo}}`.

Detalle completo (por que cada archivo es autocontenido, como copiar el codigo
de verificacion de la consola del server, como dejar una cuenta `VERIFIED` o
`ADMIN` en local) en `backend.md`, seccion "Pruebas manuales (`.rest`)".

## Integraciones

- **PostgreSQL/Neon** vía Prisma.
- **Stripe** en modo de prueba, con Connect (*separate charges & transfers*).
  `PAYMENTS_PROVIDER=mock` es un provider offline solo para la suite.
- **Cloudinary**: fotos públicas (`upload`) y documentos privados
  (`authenticated`, URLs firmadas efímeras solo para admins).
- **Gmail SMTP** para mails; **Twilio** opcional para SMS (`SMS_PROVIDER=mock`
  manda el código del teléfono por mail).
- **Groq** para el chat, la revisión de fotos de autos y de denuncias, y la
  transcripción de notas de voz.
- **docverify-api** (Python) para leer DNI y licencias.

## Flujo De Reserva

1. Quien alquila pide la reserva sobre una publicación `ACTIVE` (licencia
   vigente requerida). `REQUESTED` no ocupa el calendario.
2. El dueño acepta o rechaza. Aceptar vuelve a controlar la disponibilidad con
   la publicación bloqueada, congela los precios, genera los códigos QR
   (hash + copia cifrada), crea el contrato y lo acepta por el dueño.
3. Quien alquila acepta el contrato y paga **un solo cobro** (alquiler +
   cobertura): `POST /payments/bookings/:id/checkout`. El webhook de Stripe (o
   la consulta de estado, que concilia) deja la reserva `FULLY_PAID`.
4. El dueño marca `READY_FOR_PICKUP`: ahí se autoriza el depósito en garantía
   con la tarjeta guardada (o quien alquila lo autoriza con 3-D Secure).
5. Entrega: quien alquila muestra su código (`GET /bookings/:id/tokens`) y el
   dueño lo confirma → `IN_PROGRESS`.
6. Devolución: el dueño muestra su código y quien alquila lo confirma →
   `INSPECTION`, con una ventana para reportar daños (48 h por omisión).
7. Cerrada la ventana sin reclamo (o resuelto el reclamo), la reserva se
   **liquida**: se suelta o se cobra el depósito, se reparte la plata en el
   libro y se transfiere al dueño. Lo hace el cron diario o cualquiera de las
   partes con `POST /bookings/:id/settle` → `COMPLETED`.

Cancelar sigue `bookings/cancellation-policy.ts` y
`payments/money/cancellation-policy.ts` (con más de 48 h vuelve todo; después,
se retiene la seña; si cancela el dueño, la devuelve doblada).

## Verificación De Identidad (DNI + licencia)

La cuenta queda `VERIFIED` —requisito para publicar, reservar y pagar— con el
email confirmado, el **DNI aprobado** (y el teléfono, si
`REQUIRE_PHONE_VERIFICATION` lo exige). La licencia no verifica la cuenta:
habilita a manejar, y se exige para pedir una reserva.

1. La persona carga `dni` y `cuil` en su perfil (`PATCH /users/me`, con
   validación del CUIL) y declara los datos de cada documento.
2. Pide una firma por foto (`POST /verification/identity/upload-signature`),
   sube cada cara **directo a Cloudinary** como asset `authenticated` con un
   `public_id` que arma el servidor, y envía las URLs a
   `POST /verification/identity/:document/submit` (`dni` | `license`).
3. Si `DOCVERIFY_URL` está configurada, el backend baja las fotos y se las manda
   a `docverify-api` junto con una URL de vuelta y un token de un solo uso. La
   API contesta enseguida y, al terminar, llama a
   `POST /verification/identity/analysis-callback`. `IdentityMatchService` cruza
   lo leído contra lo declarado: si coincide, el documento se aprueba; si no,
   queda `FAILED` con el motivo y la foto a repetir.
4. Sin lectura automática (o si falla de nuestro lado) el documento queda
   `PENDING` y lo resuelve un admin (`/admin/verifications`). La persona puede
   pedir la revisión manual de un documento fallado.

Ningún dato sale de la foto hacia la cuenta: lo declarado pasa a ser la verdad
de la cuenta solo si la foto lo confirma. Las fotos solo las ve un admin (URLs
firmadas efímeras, acceso auditado) y se purgan según la política de
retención (`src/retention`). Un mismo DNI/CUIL no puede verificar dos cuentas.

`public/demo/verificacion.html` (servido en `/demo/verificacion.html`) recorre
el flujo real paso por paso y muestra en cuál falla.

## Tests Y Checks

```bash
npm run build
npm run lint
npm test                 # unitarios + e2e (necesita .env.test, ver abajo)
npm run check:env
npm run check:prisma
npm run check:docverify  # por qué el backend no llega a la API de lectura
npm run preflight
```

Los e2e corren contra una base **descartable**: copiar `.env.test.example` a
`.env.test` y apuntar `DATABASE_URL` a un Postgres de prueba
(`ALLOW_DB_RESET=true` es obligatorio; la suite vacía todas las tablas). CI
(`.github/workflows/test.yml`) hace lo mismo con un servicio `postgres:16`.

Checks contra un servidor levantado o un deploy:

```bash
npm run test:endpoints:local
API_BASE_URL="https://tu-backend.vercel.app" npm run test:endpoints:deployed
API_BASE_URL="https://tu-backend.vercel.app" npm run verify:deployed
TARGET_URL="http://localhost:3000" npm run test:functional
```
