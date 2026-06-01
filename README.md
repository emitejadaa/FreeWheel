# FreeWheel Backend

Backend NestJS para un marketplace de alquiler de autos entre usuarios. La progresion actual cubre autenticacion, perfil, vehiculos, listings, disponibilidad, reservas, pagos mock reemplazables, verificaciones internas, administracion basica y media metadata.

El backend esta preparado para ejecutarse localmente como Nest/Express y desplegarse en Vercel como funcion serverless usando `api/index.ts`.

## Stack

- NestJS 11 con Express
- TypeScript
- Prisma 6
- PostgreSQL, recomendado con Neon para remoto
- JWT con `@nestjs/jwt` y `passport-jwt`
- Google OAuth opcional con `passport-google-oauth20`
- Email opcional con Gmail SMTP via `nodemailer`
- bcryptjs
- class-validator y class-transformer
- Jest
- Vercel Serverless Functions

## Estructura

```txt
api/index.ts                     Entrada serverless de Vercel
src/main.ts                      Entrada local/prod tradicional
src/app.factory.ts               Fabrica compartida de Express + Nest
src/app.module.ts                Modulos principales
src/cors.config.ts               CORS permisivo: refleja cualquier origen entrante
src/config/public-urls.ts        URLs publicas compartidas
src/auth                         Registro, login, JWT, Google OAuth, password reset
src/users                        Perfil propio y serializacion segura de usuario
src/vehicles                     CRUD de vehiculos con ownership
src/listings                     CRUD/catalogo publico de publicaciones
src/availability                 Disponibilidad y bloqueos manuales por listing
src/verification                 Codigos email/phone e identidad metadata
src/bookings                     Reservas y tokens de pickup/return
src/admin                        Operaciones protegidas por rol ADMIN
src/media                        Registro de assets externos por metadata
src/payments                     Provider mock reemplazable para pagos simulados
src/email                        Envio opcional de emails transaccionales
src/prisma                       PrismaService compartido
src/common                       Guards, decorators, servicios comunes
prisma/schema.prisma             Modelos y enums Prisma
prisma/migrations                Historial de migraciones
scripts                         Validaciones, checks y herramientas locales
test                             E2E base
```

## Variables De Entorno

Crear un `.env` local desde `.env.example`. No commitear secretos reales.

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
CORS_ORIGINS="https://preview-a.vercel.app,https://preview-b.vercel.app"
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

Notas:

- `API_BASE_URL` es la URL publica del backend. En Vercel tambien puede resolverse desde `VERCEL_URL`.
- CORS admite cualquier origen entrante y mantiene `credentials: true` para evitar bloqueos entre frontends, previews y deploys.
- `FRONTEND_URL` se usa para redireccion Google y links de recuperacion de password.
- `CORS_ORIGINS` queda documentada por compatibilidad, pero el backend actual no filtra origenes.
- `JWT_EXPIRES_IN` controla la expiracion de tokens emitidos por `JwtModule`.
- `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` habilitan la estrategia Google solo si ambos existen.
- `GMAIL_USER` y `GMAIL_APP_PASSWORD` habilitan envio real de email. Si faltan, el servicio loguea warning y no envia.

## Instalacion Y Desarrollo

```bash
npm install
npm run start:dev
```

Base local por defecto:

```txt
http://localhost:3000
```

El `postinstall` ejecuta `prisma generate`.

## Vercel Serverless

La configuracion activa esta en `vercel.json`.

```json
{
  "version": 2,
  "buildCommand": "prisma migrate deploy && nest build",
  "builds": [{ "src": "api/index.ts", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "api/index.ts" }]
}
```

`api/index.ts` exporta el server Express creado por `src/app.factory.ts`. Esa fabrica cachea la app Nest para reducir trabajo entre invocaciones serverless.

Configurar en Vercel como minimo:

```env
DATABASE_URL="postgresql://..."
JWT_SECRET="..."
JWT_EXPIRES_IN="24h"
FRONTEND_URL="https://tu-front.vercel.app"
API_BASE_URL="https://tu-backend.vercel.app"
```

Si falta `JWT_SECRET`, la aplicacion usa un valor por defecto interno por continuidad (deuda de seguridad). Configurar `JWT_SECRET` en el entorno para usar un secreto propio.

Las migraciones Prisma no se ejecutan dentro del handler serverless. En Vercel se aplican durante el build por `buildCommand`, por lo que `DATABASE_URL` debe estar disponible en build. Para otros entornos se pueden aplicar con:

```bash
npm run db:migrate:deploy
```

## Prisma

Modelos principales:

- `User`: cuenta, credenciales, rol, estado, verificacion, Google ID y relaciones.
- `Vehicle`: vehiculos propios con atributos tecnicos.
- `Listing`: publicaciones asociadas a vehiculos y owner.
- `ListingAvailabilityBlock`: bloqueos manuales por owner para impedir reservas en rangos concretos.
- `Booking`: reservas con snapshots de precio, estado y tokens de entrega/devolucion.
- `VerificationCode`: codigos hasheados para email y password reset.
- `UserVerification`: metadata de verificacion de identidad.
- `PaymentRecord`: registro de sesiones/eventos del proveedor mock, disenado para reemplazo por proveedor real.
- `MediaAsset`: metadata de archivos externos.
- `AuditLog`: auditoria administrativa.

Enums relevantes: `UserRole`, `UserStatus`, `VerificationStatus`, `ListingStatus`, `BookingStatus`, `PaymentStatus`, `MediaAssetKind`, `MediaAssetStatus`.

Comandos:

```bash
npm run check:prisma
npx prisma migrate dev
npm run db:migrate:deploy
```

No usar migraciones destructivas ni `db push` contra produccion sin confirmacion explicita.

## Recursos Nest

- `AuthModule`: register/login, JWT, email verification, password reset y Google OAuth opcional.
- `UsersModule`: lectura y actualizacion de perfil propio.
- `VehiclesModule`: alta, lectura, edicion y baja de vehiculos propios.
- `ListingsModule`: publicaciones propias y catalogo publico activo.
- `VerificationModule`: verificacion interna de email/phone e identidad por URLs/metadata.
- `BookingsModule`: solicitudes, aceptacion/rechazo/cancelacion y confirmaciones por token.
- `AdminModule`: gestion protegida por `ADMIN` de usuarios, verificaciones, listings y bookings.
- `MediaModule`: registro de assets por URL y metadata.
- `PaymentsModule`: reservado para integracion futura de pagos.
- `EmailModule`: Gmail SMTP opcional para emails transaccionales.
- `PrismaModule`: cliente Prisma compartido.

## Endpoints

Publicos o auth:

- `GET /`
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`
- `GET /auth/google`
- `GET /auth/google/callback`
- `GET /listings`
- `GET /listings/:id`
- `GET /listings/:id/availability`

Usuario autenticado:

- `GET /users/me`
- `PATCH /users/me`
- `POST /auth/verify-email`
- `POST /auth/resend-verification`
- `POST /vehicles`
- `GET /vehicles/me`
- `GET /vehicles/:id`
- `PATCH /vehicles/:id`
- `DELETE /vehicles/:id`
- `POST /listings`
- `GET /listings/me`
- `PATCH /listings/:id`
- `DELETE /listings/:id`
- `POST /listings/:id/availability-blocks`
- `GET /listings/:id/availability-blocks`
- `DELETE /listings/:id/availability-blocks/:blockId`
- `POST /verification/email/request`
- `POST /verification/email/confirm`
- `POST /verification/phone/request`
- `POST /verification/phone/confirm`
- `GET /verification/me/status`
- `POST /verification/identity/submit`
- `GET /verification/identity/me`
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
- `POST /payments/bookings/:bookingId/mock-intent`
- `GET /payments/bookings/:bookingId/status`
- `POST /payments/bookings/:bookingId/mock-confirm`
- `POST /payments/bookings/:bookingId/mock-fail`
- `POST /payments/bookings/:bookingId/mock-refund`
- `POST /payments/mock/webhook`
- `POST /media/assets`
- `GET /media/assets/me`

Admin:

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

## Integraciones

- PostgreSQL/Neon: persistencia principal via Prisma.
- Vercel: runtime serverless para `api/index.ts`.
- Gmail SMTP: opcional, usado por `EmailService`.
- Google OAuth: opcional, se registra solo con credenciales presentes.
- Pagos: provider mock sin dinero real, preparado para reemplazo.
- Storage real, SMS y mensajeria todavia no tienen proveedor activo.

## Flujo De Reserva Actual

1. Renter solicita reserva sobre un listing `ACTIVE`.
2. Backend valida fechas, ownership, reservas bloqueantes y bloqueos manuales.
3. Owner acepta o rechaza. `REQUESTED` no bloquea disponibilidad hasta que una solicitud se acepta.
4. Al aceptar, backend genera tokens QR hasheados, crea un `PaymentRecord` mock `PENDING` y deja `Booking.paymentStatus` en `PENDING`.
5. Renter confirma pago simulado con `POST /payments/bookings/:bookingId/mock-confirm` o un webhook fake.
6. Owner marca `READY_FOR_PICKUP` solo si el pago esta `PAID`.
7. Renter muestra QR/token de retiro desde `GET /bookings/:id/tokens`.
8. Owner confirma retiro con `POST /bookings/:id/confirm-pickup`.
9. Reserva queda `IN_PROGRESS`.
10. Owner muestra QR/token de devolucion desde `GET /bookings/:id/tokens`.
11. Renter confirma devolucion con `POST /bookings/:id/confirm-return`.
12. Reserva queda `COMPLETED` y el pago mock registra liberacion.

## Disponibilidad

`GET /listings/:id/availability?startDate=...&endDate=...` informa si un rango esta disponible y devuelve reservas/bloqueos que chocan. Los owners pueden crear, listar y eliminar bloqueos manuales con `/listings/:id/availability-blocks`. La validacion de solapamientos vive en `AvailabilityService` y se reutiliza en bookings y en filtros publicos de listings.

## Pagos Mock

El flujo de pagos no usa dinero real ni datos de tarjeta. `PaymentsService` coordina `PaymentRecord` y `Booking.paymentStatus`; `MockPaymentsProvider` solo genera IDs fake. Para reemplazarlo por Stripe, Mercado Pago u otro provider, implementar la misma frontera interna de provider y mapear webhooks reales a `confirm/fail/refund/release`.

## QR Tokens

Los tokens de pickup/return se guardan hasheados. Para compatibilidad temporal con frontend, el backend conserva `pickupTokenPreview` y `returnTokenPreview` hasta que el token se consume; no se exponen a usuarios fuera del rol/estado correspondiente y se limpian al confirmar pickup/return. Esta preview debe reemplazarse por emision efimera o canal seguro antes de produccion sensible.

## Tests Y Checks

```bash
npm run build
npm test
npm run check:env
npm run check:prisma
npm run preflight
```

Checks de endpoints:

```bash
npm run test:endpoints:local
API_BASE_URL="https://tu-backend.vercel.app" npm run test:endpoints:deployed
API_BASE_URL="https://tu-backend.vercel.app" npm run verify:deployed
```

Testing funcional:

```bash
TARGET_URL="http://localhost:3000" npm run test:functional
API_BASE_URL="https://tu-backend.vercel.app" npm run test:functional
FRONTEND_URL="https://tu-front.vercel.app" API_BASE_URL="https://tu-backend.vercel.app" npm run test:functional
```

`npm run preflight` ejecuta Prisma, build y tests. Luego intenta el checker local; si el servidor no esta levantado, informa que hay que iniciar `npm run start:dev`.

## Estado Actual

Implementado:

- Auth con register/login, JWT y expiracion configurable.
- Recuperacion de password y verificacion de email con codigos hasheados.
- Google OAuth opcional.
- Perfil propio y serializacion segura de usuario.
- Roles guard y endpoints admin protegidos.
- CRUD de vehiculos con ownership.
- CRUD de listings, soft delete y catalogo publico activo.
- Filtros, paginacion y sorting en listings.
- Disponibilidad por listing con bloqueos manuales y filtros por fecha.
- Bookings con estados, snapshots, tokens y pago mock requerido antes de pickup.
- Pagos mock integrados al ciclo de reserva.
- Registro de media por URL/metadata.
- Payment records preparados sin proveedor externo.
- CORS permisivo para requests desde cualquier origen.
- Entrada serverless para Vercel.

Proximos pasos razonables:

- Agregar healthcheck explicito si se necesita monitoreo dedicado.
- Definir proveedor real de storage antes de uploads.
- Definir proveedor real de pagos antes de cobrar reservas.
- Definir proveedor SMS si se necesita verificacion telefonica real.
- Mantener este README actualizado con cada cambio de contrato publico.
