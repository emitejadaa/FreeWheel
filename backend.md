# FreeWheel Backend

Este documento describe el estado actual del backend de FreeWheel: estructura NestJS, modelos Prisma, endpoints, credenciales, integraciones, herramientas, configuracion serverless y progresion implementada hasta ahora.

## Resumen

FreeWheel es un backend para un marketplace de alquiler de autos entre usuarios. El sistema permite registro/login, perfil propio, vehiculos, publicaciones, reservas, verificaciones internas, administracion basica, registro de media por metadata y preparacion para pagos futuros.

El backend corre como aplicacion NestJS sobre Express. Para Vercel se expone mediante `api/index.ts`, que reutiliza una fabrica compartida (`src/app.factory.ts`) y cachea la instancia Nest para evitar inicializaciones innecesarias entre invocaciones serverless.

## Stack Y Herramientas

- Node.js y npm
- NestJS 11
- Express mediante `@nestjs/platform-express`
- TypeScript
- Prisma 6
- PostgreSQL, con Neon como base remota recomendada
- Vercel Serverless Functions mediante `@vercel/node`
- JWT con `@nestjs/jwt` y `passport-jwt`
- Google OAuth opcional con `passport-google-oauth20`
- Hashing con `bcryptjs`, elegido para evitar problemas de binarios nativos en serverless
- Email opcional con `nodemailer` y Gmail SMTP
- Validacion con `class-validator` y `class-transformer`
- Tests con Jest y `@nestjs/testing`
- Scripts internos para env, Prisma, endpoints, preflight y commits

## Entradas De Ejecucion

- `src/main.ts`: entrada local/tradicional. Crea el server y escucha en `PORT` o `3000`.
- `api/index.ts`: entrada serverless de Vercel. Exporta el server Express creado por `createServer()`.
- `src/app.factory.ts`: crea Express + Nest, configura CORS, pipes globales y cachea la app.

## Configuracion Serverless En Vercel

Archivo: `vercel.json`

```json
{
  "version": 2,
  "builds": [
    {
      "src": "api/index.ts",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "api/index.ts"
    }
  ]
}
```

Notas de despliegue:

- Las rutas HTTP entran por `api/index.ts`.
- La app Nest se inicializa sobre un `ExpressAdapter`.
- Prisma Client se genera en `postinstall`.
- Las migraciones no se ejecutan dentro del handler serverless. Se aplican con `npm run db:migrate:deploy`.
- `bcryptjs` evita compilacion o carga de binarios nativos en Vercel.

## CORS

Archivo: `src/cors.config.ts`

El backend actual admite cualquier origen entrante:

- `origin: true`
- `credentials: true`
- metodos: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`
- preflight exitoso con status `204`

Esto hace que Express/Nest refleje el origen recibido y evita bloqueos entre el frontend principal, previews de Vercel, localhost u otros clientes temporales.

`parseCorsOrigins()` se conserva por compatibilidad con documentacion/tests previos, pero `createCorsOptions()` ya no filtra por whitelist.

## Variables De Entorno

Archivo base: `.env.example`

Requeridas:

```env
DATABASE_URL="postgresql://user:password@host:5432/freewheel?sslmode=require"
JWT_SECRET="replace-with-a-secure-secret"
```

Opcionales:

```env
JWT_EXPIRES_IN="24h"
PORT=3000
LOCAL_API_URL="http://localhost:3000"
API_BASE_URL="https://tu-backend.vercel.app"
FRONTEND_URL="https://tu-front.vercel.app"
CORS_ORIGINS=""
TARGET_URL=""
TEST_EMAIL=""
TEST_PASSWORD=""
FUNCTIONAL_TEST_TIMEOUT_MS=10000
DEPLOY_VERIFY_ATTEMPTS=5
DEPLOY_VERIFY_DELAY_MS=15000
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GMAIL_USER=""
GMAIL_APP_PASSWORD=""
```

Uso actual:

- `DATABASE_URL`: conexion PostgreSQL usada por Prisma.
- `JWT_SECRET`: firma de access tokens.
- `JWT_EXPIRES_IN`: expiracion de tokens, por defecto `24h`.
- `PORT`: puerto local/tradicional.
- `LOCAL_API_URL`: URL usada por el checker local.
- `API_BASE_URL`: URL publica del backend para callbacks OAuth y pruebas remotas.
- `VERCEL_URL`: si existe y falta `API_BASE_URL`, se usa para construir URL publica del backend.
- `FRONTEND_URL`: redireccion Google y links de reset password.
- `CORS_ORIGINS`: conservada por compatibilidad, actualmente no restringe CORS.
- `TARGET_URL`: URL generica para scripts funcionales.
- `TEST_EMAIL` y `TEST_PASSWORD`: credenciales opcionales para pruebas funcionales.
- `FUNCTIONAL_TEST_TIMEOUT_MS`: timeout del test funcional.
- `DEPLOY_VERIFY_ATTEMPTS` y `DEPLOY_VERIFY_DELAY_MS`: reintentos del verificador desplegado.
- `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`: habilitan Google OAuth si ambas estan presentes.
- `GMAIL_USER` y `GMAIL_APP_PASSWORD`: habilitan envio real de emails.

## Manejo De Credenciales

- No commitear `.env` con secretos reales.
- `.env.example` solo contiene placeholders.
- En Vercel, configurar secretos desde Project Settings o CLI.
- `JWT_SECRET`, `DATABASE_URL`, credenciales Google y credenciales Gmail son secretos.
- `FRONTEND_URL`, `API_BASE_URL`, `PORT` y timeouts no son secretos.
- Si faltan credenciales Gmail, `EmailService` no envia emails y registra un warning.
- Si faltan credenciales Google, `GoogleStrategy` no se registra en `AuthModule`.

## Estructura De Carpetas

```txt
api/
  index.ts
prisma/
  schema.prisma
  migrations/
scripts/
  endpoint-checker/
    check-local.ts
    check-deployed.ts
    verify-deployed.ts
    shared.ts
  env-check.ts
  preflight.ts
  prisma-check.ts
  smart-commit.ts
  test-functional.ts
src/
  admin/
  auth/
  bookings/
  common/
  config/
  email/
  listings/
  media/
  payments/
  prisma/
  users/
  vehicles/
  verification/
  app.controller.ts
  app.factory.ts
  app.module.ts
  app.service.ts
  cors.config.ts
  main.ts
test/
```

## Modulos NestJS

### AppModule

Archivo: `src/app.module.ts`

Importa `ConfigModule.forRoot({ isGlobal: true })` y registra los modulos de dominio:

- `PrismaModule`
- `AuthModule`
- `UsersModule`
- `VehiclesModule`
- `ListingsModule`
- `VerificationModule`
- `AdminModule`
- `BookingsModule`
- `PaymentsModule`
- `MediaModule`

### AuthModule

Responsabilidades:

- Registro de usuarios
- Login con email/password
- Emision de JWT
- Verificacion de email
- Reenvio de verificacion
- Forgot/reset password
- Google OAuth opcional

Servicios y estrategias:

- `AuthService`
- `JwtStrategy`
- `GoogleStrategy` solo si existen `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`
- `EmailService`

### UsersModule

Responsabilidades:

- Buscar usuarios por email/id
- Serializar usuario seguro sin password
- Obtener perfil propio
- Actualizar perfil propio

### VehiclesModule

Responsabilidades:

- Crear vehiculo propio
- Listar vehiculos propios
- Obtener vehiculo por id
- Actualizar vehiculo propio
- Eliminar vehiculo propio
- Validar ownership

### ListingsModule

Responsabilidades:

- Crear listing asociado a vehiculo propio
- Listar catalogo publico de listings activos
- Listar listings propios
- Obtener listing por id
- Actualizar listing propio
- Soft delete de listing
- Filtros, paginacion y ordenamiento

### VerificationModule

Responsabilidades:

- Solicitar codigo email
- Confirmar codigo email
- Solicitar codigo phone
- Confirmar codigo phone
- Consultar estado propio
- Enviar metadata de identidad
- Consultar identidad propia

Actualmente las verificaciones son internas. No hay proveedor SMS real integrado.

### BookingsModule

Responsabilidades:

- Crear solicitud de reserva
- Listar reservas propias
- Obtener reserva por id
- Aceptar/rechazar/cancelar
- Marcar ready for pickup
- Emitir/consultar tokens
- Confirmar pickup
- Confirmar return

Los tokens se guardan hasheados con `bcryptjs`.

### AdminModule

Responsabilidades protegidas por `ADMIN`:

- Listar usuarios
- Ver usuario
- Cambiar estado de usuario
- Cambiar rol de usuario
- Listar verificaciones
- Revisar verificacion
- Listar listings
- Cambiar estado de listing
- Listar bookings
- Ver booking

### MediaModule

Responsabilidades:

- Registrar assets por URL y metadata
- Listar assets propios

No sube archivos a storage por si mismo. El backend espera una URL ya disponible.

### PaymentsModule

Modulo reservado para integracion futura. El schema ya tiene `PaymentRecord` y estados, pero no hay proveedor real conectado.

### EmailModule

Responsabilidades:

- Envio de codigo de verificacion
- Envio de reset password

Usa Gmail SMTP si existen `GMAIL_USER` y `GMAIL_APP_PASSWORD`.

### PrismaModule

Expone `PrismaService`, que extiende `PrismaClient` e implementa:

- `$connect()` en `onModuleInit`
- `$disconnect()` en `onModuleDestroy`

## Guards, Decorators Y Tipos Comunes

- `JwtAuthGuard`: protege rutas autenticadas.
- `RolesGuard`: valida roles requeridos.
- `@Roles(...)`: define roles requeridos en controladores.
- `@CurrentUser()`: obtiene el usuario actual desde request.
- `CurrentUser`: tipo comun para usuario autenticado.
- `AuditLogService`: registra acciones administrativas o relevantes.

## Prisma Schema

Archivo: `prisma/schema.prisma`

Datasource:

- provider: `postgresql`
- url: `env("DATABASE_URL")`

Generator:

- `prisma-client-js`

### Enums

- `UserRole`: `USER`, `ADMIN`
- `UserStatus`: `ACTIVE`, `PENDING_VERIFICATION`, `SUSPENDED`, `DELETED`
- `VerificationStatus`: `UNVERIFIED`, `EMAIL_VERIFIED`, `PHONE_VERIFIED`, `ID_SUBMITTED`, `VERIFIED`, `REJECTED`
- `ListingStatus`: `DRAFT`, `ACTIVE`, `PAUSED`, `DELETED`
- `TransmissionType`: `MANUAL`, `AUTOMATIC`
- `FuelType`: `GASOLINE`, `DIESEL`, `HYBRID`, `ELECTRIC`, `OTHER`
- `DrivetrainType`: `REAR`, `FRONT`, `FOUR_BY_FOUR`, `AWD`
- `VerificationCodeTargetType`: `EMAIL`, `PHONE`
- `VerificationCodePurpose`: `EMAIL_VERIFICATION`, `PASSWORD_RESET`
- `BookingStatus`: `REQUESTED`, `ACCEPTED`, `REJECTED`, `CANCELLED_BY_RENTER`, `CANCELLED_BY_OWNER`, `READY_FOR_PICKUP`, `IN_PROGRESS`, `RETURN_PENDING`, `COMPLETED`, `DISPUTED`
- `PaymentStatus`: `NOT_REQUIRED`, `PENDING`, `PAID`, `REFUNDED`, `FAILED`
- `PaymentRecordStatus`: `MOCK`, `PENDING`, `PAID`, `REFUNDED`, `FAILED`, `CANCELLED`
- `MediaAssetKind`: `PROFILE_PHOTO`, `VEHICLE_PHOTO`, `DOCUMENT`, `SELFIE`, `LISTING_PHOTO`
- `MediaAssetStatus`: `PENDING`, `ACTIVE`, `DELETED`

### Modelos

#### User

Cuenta principal del usuario.

Campos clave:

- `id`
- `email`
- `password`
- `firstName`
- `lastName`
- `displayName`
- `phone`
- `profilePhotoUrl`
- `role`
- `status`
- `verificationStatus`
- `emailVerifiedAt`
- `acceptedTermsAt`
- `googleId`
- `phoneVerifiedAt`
- timestamps

Relaciones:

- `vehicles`
- `listings`
- `verifications`
- `verificationCodes`
- `bookingsAsOwner`
- `bookingsAsRenter`
- `paymentRecords`
- `mediaAssets`
- `auditLogsAsActor`
- `auditLogsAsTarget`

#### UserVerification

Metadata de verificacion de identidad.

Campos:

- `userId`
- `status`
- `documentUrl`
- `selfieUrl`
- `notes`
- `reviewedAt`

#### VerificationCode

Codigos/token hasheados para email verification y password reset.

Campos:

- `userId`
- `targetType`
- `targetValue`
- `purpose`
- `codeHash`
- `expiresAt`
- `consumedAt`
- `attempts`
- `maxAttempts`

#### Vehicle

Vehiculo propiedad de un usuario.

Campos:

- `ownerId`
- `brand`
- `model`
- `year`
- `plate`
- `color`
- `seats`
- `transmission`
- `fuelType`
- `drivetrain`
- equipamiento
- dimensiones
- `observations`

#### Listing

Publicacion de un vehiculo.

Campos:

- `vehicleId`
- `ownerId`
- `title`
- `description`
- `pricePerDay`
- `locationText`
- coordenadas
- delivery coords/radius
- `status`

#### Booking

Reserva entre renter y owner.

Campos:

- `listingId`
- `vehicleId`
- `ownerId`
- `renterId`
- `startDate`
- `endDate`
- `status`
- `pricePerDaySnapshot`
- `totalPriceSnapshot`
- `currency`
- `pickupTokenHash`
- `returnTokenHash`
- token previews
- timestamps de confirmacion
- cancelacion
- payment status/provider snapshots

#### PaymentRecord

Registro preparado para pagos.

Campos:

- `bookingId`
- `userId`
- `status`
- `provider`
- `providerId`
- `amount`
- `currency`
- `metadata`
- `paidAt`
- `refundedAt`

#### MediaAsset

Metadata de archivo externo.

Campos:

- `ownerId`
- `entityType`
- `entityId`
- `kind`
- `url`
- `storageProvider`
- `storageKey`
- `mimeType`
- `sizeBytes`
- `status`

#### AuditLog

Auditoria de acciones.

Campos:

- `actorId`
- `targetUserId`
- `action`
- `entityType`
- `entityId`
- `metadata`
- `createdAt`

## Endpoints

### Root

- `GET /`

### Auth

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/verify-email`
- `POST /auth/resend-verification`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`
- `GET /auth/google`
- `GET /auth/google/callback`

### Users

- `GET /users/me`
- `PATCH /users/me`

### Vehicles

- `POST /vehicles`
- `GET /vehicles/me`
- `GET /vehicles/:id`
- `PATCH /vehicles/:id`
- `DELETE /vehicles/:id`

### Listings

- `POST /listings`
- `GET /listings`
- `GET /listings/me`
- `GET /listings/:id`
- `PATCH /listings/:id`
- `DELETE /listings/:id`

### Verification

- `POST /verification/email/request`
- `POST /verification/email/confirm`
- `POST /verification/phone/request`
- `POST /verification/phone/confirm`
- `GET /verification/me/status`
- `POST /verification/identity/submit`
- `GET /verification/identity/me`

### Bookings

- `POST /bookings`
- `GET /bookings/me`
- `GET /bookings/:id`
- `PATCH /bookings/:id/accept`
- `PATCH /bookings/:id/reject`
- `PATCH /bookings/:id/cancel`
- `PATCH /bookings/:id/ready-for-pickup`
- `GET /bookings/:id/tokens`
- `POST /bookings/:id/confirm-pickup`
- `POST /bookings/:id/confirm-return`

### Media

- `POST /media/assets`
- `GET /media/assets/me`

### Admin

- `GET /admin/users`
- `GET /admin/users/:id`
- `PATCH /admin/users/:id/status`
- `PATCH /admin/users/:id/role`
- `GET /admin/verifications`
- `GET /admin/verifications/:id`
- `PATCH /admin/verifications/:id/review`
- `GET /admin/listings`
- `PATCH /admin/listings/:id/status`
- `GET /admin/bookings`
- `GET /admin/bookings/:id`

## Autenticacion Y Autorizacion

JWT:

- Login/register devuelven `accessToken`.
- El token lleva `email` en payload y `subject` con `userId`.
- La expiracion se define con `JWT_EXPIRES_IN`.
- `JwtStrategy` usa `JWT_SECRET`.

Roles:

- `USER` es default.
- `ADMIN` accede a rutas administrativas.
- `RolesGuard` valida metadata de `@Roles`.

Google:

- Se habilita solo si existen `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.
- Callback: `${API_BASE_URL || VERCEL_URL || localhost}/auth/google/callback`.
- Redireccion final al frontend: `${FRONTEND_URL}/auth/google/callback?token=...`.

## Validacion

`src/app.factory.ts` registra `ValidationPipe` global con:

- `whitelist: true`
- `forbidNonWhitelisted: true`
- `transform: true`

Esto limpia payloads, rechaza campos no declarados y transforma tipos cuando corresponde.

## Integraciones Activas

- PostgreSQL/Neon via Prisma.
- Vercel Serverless Functions.
- Gmail SMTP opcional via Nodemailer.
- Google OAuth opcional.

## Integraciones Preparadas Pero No Activas

- Pagos reales.
- Storage real de archivos.
- SMS real.
- Mensajeria entre usuarios.
- Healthcheck dedicado.

## Scripts

```bash
npm run build
npm run start
npm run start:dev
npm run start:prod
npm run test
npm run test:e2e
npm run test:endpoints:local
npm run test:endpoints:deployed
npm run test:functional
npm run test:functional:deployed
npm run db:migrate:deploy
npm run verify:deployed
npm run check:env
npm run check:prisma
npm run preflight
npm run commit:smart
```

Detalles:

- `postinstall`: ejecuta `prisma generate`.
- `check:env`: valida requeridas y documentacion de `.env.example`.
- `check:prisma`: valida schema y genera Prisma Client.
- `preflight`: Prisma, build, tests y checker local si el server esta arriba.
- `verify:deployed`: reintenta checks sobre `API_BASE_URL` o `TARGET_URL`.

## Testing

Suites actuales:

- controllers basicos
- servicios auth/users/vehicles/listings/bookings/verification/admin/prisma
- guards
- CORS config

Comandos usados para validar:

```bash
npm run build
npm test -- --runInBand
npm run check:env
npm run check:prisma
npm audit --omit=dev
```

## Estado De Progresion

Implementado:

- Auth local con email/password.
- JWT configurable.
- Password hashing con `bcryptjs`.
- Verificacion de email con codigos hasheados.
- Recuperacion de password con tokens hasheados.
- Google OAuth opcional.
- Perfil propio.
- CRUD de vehiculos con ownership.
- CRUD/listado de listings.
- Soft delete de listings.
- Reservas con estados, snapshots y tokens.
- Confirmacion de pickup/return por token.
- Admin para usuarios, verificaciones, listings y bookings.
- Registro de media por URL.
- Payment records preparados a nivel schema.
- CORS permisivo para cualquier origen.
- Deploy serverless en Vercel.
- Documentacion actualizada en README y este archivo.

Pendiente o futuro:

- Provider de pagos.
- Upload/storage real.
- SMS real.
- Mensajeria.
- Healthcheck dedicado.
- Observabilidad avanzada.
- Rate limiting.
- Politicas finas de CORS si mas adelante se decide restringir origenes.

## Notas Operativas

- Para desarrollo local: `npm run start:dev`.
- Para Vercel: configurar env vars en el proyecto y dejar que `api/index.ts` maneje requests.
- Para migraciones remotas: `npm run db:migrate:deploy`.
- Para probar deploy: `API_BASE_URL="https://tu-backend.vercel.app" npm run verify:deployed`.
- Si hay errores de CORS, revisar que el deploy tenga la ultima version: el backend actual no bloquea por origen.
- Si hay errores relacionados con hashing, verificar que no quede import a `bcrypt`; debe usarse `bcryptjs`.
