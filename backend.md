# FreeWheel Backend

Documento maestro del backend de FreeWheel. Describe el contexto del proyecto, arquitectura, estructura de carpetas, modulos NestJS, endpoints, modelos Prisma, flujos de dominio, integraciones, scripts, estado actual, riesgos conocidos y roadmap tecnico.

## 1. Contexto Del Proyecto

FreeWheel es un backend NestJS para un marketplace de alquiler de autos entre usuarios. El producto permite que un owner publique vehiculos y que un renter solicite reservas en fechas concretas. El sistema ya cubre autenticacion, usuarios, vehiculos, listings, disponibilidad, reservas, pagos mock, verificacion, administracion, media metadata, auditoria y despliegue serverless en Vercel.

El backend esta pensado para evolucionar hacia produccion con:

- PostgreSQL administrado en Neon.
- Vercel Serverless Functions como runtime HTTP.
- Prisma como ORM y capa de migraciones.
- JWT para autenticacion de API.
- Google OAuth opcional.
- Gmail SMTP opcional para emails transaccionales.
- Provider mock de pagos reemplazable por Stripe, Mercado Pago u otro proveedor real.
- Registro de metadata de archivos externos, compatible con assets subidos fuera del backend.

## 2. Principios De Diseno

- Separar dominio por modulos NestJS: auth, users, vehicles, listings, availability, bookings, payments, media, verification, admin, email, prisma y common.
- Mantener ownership claro: owners administran sus vehiculos, listings y bloqueos; renters administran sus solicitudes y pagos.
- No duplicar reglas de disponibilidad: los solapamientos viven en `AvailabilityService`.
- No acoplar reservas a un proveedor fake: `PaymentsService` coordina records y estado, y el provider mock queda encapsulado.
- Nunca exponer hashes de password ni secretos.
- Guardar tokens operativos hasheados; mantener previews de QR solo como compatibilidad temporal.
- Usar migraciones Prisma, no `db push`, para cambios persistentes.
- Mantener Vercel serverless sin dependencias nativas fragiles; por eso se usa `bcryptjs`.

## 3. Stack Tecnico

- Node.js y npm.
- NestJS 11.
- Express mediante `@nestjs/platform-express`.
- TypeScript.
- Prisma 6.
- PostgreSQL, recomendado con Neon.
- Vercel Serverless Functions mediante `@vercel/node`.
- JWT con `@nestjs/jwt` y `passport-jwt`.
- Google OAuth opcional con `passport-google-oauth20`.
- Hashing con `bcryptjs`.
- Validacion con `class-validator` y `class-transformer`.
- Email opcional con `nodemailer` y Gmail SMTP.
- Jest y `@nestjs/testing`.
- Supertest para E2E base.
- Scripts internos para env, Prisma, endpoints, preflight, pruebas funcionales y commits.

## 4. Entradas De Ejecucion

- `src/main.ts`: entrada local/tradicional. Crea el server y escucha en `PORT` o `3000`.
- `api/index.ts`: entrada serverless de Vercel. Exporta el server Express creado por `createServer()`.
- `src/app.factory.ts`: crea Express + Nest, configura CORS, pipes globales y cachea la app Nest.
- `src/app.module.ts`: modulo raiz que registra todos los modulos de dominio.

La app usa `ValidationPipe` global con:

- `whitelist: true`
- `forbidNonWhitelisted: true`
- `transform: true`

Esto transforma DTOs, elimina campos no declarados y rechaza payloads con propiedades extra.

## 5. Estructura De Carpetas

```txt
api/
  index.ts                         Entrada serverless de Vercel

prisma/
  schema.prisma                    Schema Prisma principal
  migrations/                      Historial de migraciones SQL

scripts/
  endpoint-checker/
    check-local.ts                 Checker contra LOCAL_API_URL
    check-deployed.ts              Checker contra API_BASE_URL o TARGET_URL
    verify-deployed.ts             Checker con reintentos para deploys
    shared.ts                      Utilidades compartidas de endpoint checker
  env-check.ts                     Valida variables requeridas y documentadas
  preflight.ts                     Corre Prisma, build, tests y checker local
  prisma-check.ts                  Valida schema y ejecuta prisma generate
  smart-commit.ts                  Script local de commit asistido
  test-functional.ts               Flujo funcional multiendpoint

src/
  admin/                           Operaciones administrativas protegidas por ADMIN
  auth/                            Register, login, JWT, OAuth, email verification, password reset
  availability/                    Disponibilidad y bloqueos manuales por listing
  bookings/                        Ciclo de reserva y tokens pickup/return
  common/                          Guards, decorators, tipos y servicios comunes
  config/                          Helpers de URLs publicas
  email/                           EmailService con Gmail SMTP opcional
  listings/                        Publicaciones y catalogo publico
  media/                           Registro/listado de metadata de assets
  payments/                        Provider mock y coordinacion de PaymentRecord
  prisma/                          PrismaModule y PrismaService
  users/                           Perfil propio y serializacion segura
  vehicles/                        CRUD de vehiculos con ownership
  verification/                    Codigos email/phone e identidad
  app.controller.ts                Root endpoint
  app.factory.ts                   Fabrica Express + Nest
  app.module.ts                    Modulo raiz
  app.service.ts                   Servicio root
  cors.config.ts                   Configuracion CORS
  main.ts                          Entrada local

test/
  app.e2e-spec.ts                  E2E base
  jest-e2e.json                    Config E2E
```

## 6. Modulos NestJS Y Recursos

### AppModule

Archivo: `src/app.module.ts`

Responsabilidades:

- Cargar `ConfigModule.forRoot({ isGlobal: true })`.
- Registrar modulos de dominio.
- Centralizar el wiring principal de Nest.

Imports principales:

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

### PrismaModule

Archivos:

- `src/prisma/prisma.module.ts`
- `src/prisma/prisma.service.ts`

Responsabilidades:

- Exponer `PrismaService`.
- Extender `PrismaClient`.
- Conectar en `onModuleInit`.
- Desconectar en `onModuleDestroy`.

Notas:

- Prisma usa `DATABASE_URL`.
- El cliente se genera en `postinstall` y en `npm run check:prisma`.
- Las migraciones viven en `prisma/migrations`.

### CommonModule

Archivos:

- `src/common/common.module.ts`
- `src/common/decorators/current-user.decorator.ts`
- `src/common/decorators/roles.decorator.ts`
- `src/common/guards/roles.guard.ts`
- `src/common/services/audit-log.service.ts`
- `src/common/types/current-user.type.ts`

Recursos:

- `@CurrentUser()`: obtiene el usuario autenticado desde request.
- `@Roles(...)`: declara roles requeridos.
- `RolesGuard`: valida roles contra metadata.
- `AuditLogService`: crea registros en `AuditLog`.
- `CurrentUserPayload`: tipo comun de usuario autenticado.

### AuthModule

Archivos principales:

- `src/auth/auth.controller.ts`
- `src/auth/auth.service.ts`
- `src/auth/auth.module.ts`
- `src/auth/guards/jwt-auth.guard.ts`
- `src/auth/strategies/jwt.strategy.ts`
- `src/auth/strategies/google.strategy.ts`
- DTOs en `src/auth/dto`

Responsabilidades:

- Registro de usuarios.
- Login email/password.
- Emision de JWT.
- Verificacion de email.
- Reenvio de verificacion.
- Solicitud y confirmacion de cambio de email.
- Forgot/reset password.
- Google OAuth opcional.
- Bloqueo de login para usuarios suspendidos o eliminados.

DTOs:

- `RegisterDto`
- `LoginDto`
- `VerifyEmailDto`
- `ForgotPasswordDto`
- `ResetPasswordDto`

Estrategias:

- `JwtStrategy`: usa `JWT_SECRET`.
- `GoogleStrategy`: se registra solo si existen `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.

### UsersModule

Archivos:

- `src/users/users.controller.ts`
- `src/users/users.service.ts`
- `src/users/users.module.ts`
- `src/users/dto/update-user.dto.ts`

Responsabilidades:

- Obtener perfil propio.
- Actualizar perfil propio.
- Buscar usuario por id/email para auth y otras capas.
- Serializar usuario sin password.

Reglas:

- Nunca devolver `password`.
- Mantener campos sensibles fuera de responses publicas.

### VehiclesModule

Archivos:

- `src/vehicles/vehicles.controller.ts`
- `src/vehicles/vehicles.service.ts`
- `src/vehicles/dto/create-vehicle.dto.ts`
- `src/vehicles/dto/update-vehicle.dto.ts`

Responsabilidades:

- Crear vehiculo propio.
- Listar vehiculos propios.
- Obtener vehiculo por id.
- Actualizar vehiculo propio.
- Eliminar vehiculo propio.
- Validar ownership.
- Evitar borrar vehiculos que tienen listings asociados.

Privacidad:

- `GET /vehicles/:id` es publico, pero no debe exponer datos sensibles del owner ni placa si el servicio lo oculta.

### ListingsModule

Archivos:

- `src/listings/listings.controller.ts`
- `src/listings/listings.service.ts`
- `src/listings/dto/create-listing.dto.ts`
- `src/listings/dto/update-listing.dto.ts`
- `src/listings/dto/list-listings-query.dto.ts`

Responsabilidades:

- Crear listing asociado a vehiculo propio.
- Listar catalogo publico de listings activos.
- Listar listings propios.
- Obtener listing activo por id.
- Actualizar listing propio.
- Soft delete de listing con estado `DELETED`.
- Filtros por ubicacion, precio, marca, modelo, fechas y sort.
- Incluir fotos activas asociadas al vehiculo desde `MediaAsset`.
- Delegar disponibilidad a `AvailabilityService`.

Reglas:

- Solo el owner del vehiculo puede crear un listing para ese vehiculo.
- Solo el owner del listing puede actualizar o eliminar.
- El catalogo publico solo muestra `ACTIVE`.
- Los filtros por fecha excluyen reservas bloqueantes y bloqueos manuales.

### AvailabilityModule

Archivos:

- `src/availability/availability.module.ts`
- `src/availability/availability.service.ts`
- `src/availability/dto/availability-query.dto.ts`
- `src/availability/dto/create-availability-block.dto.ts`

Responsabilidades:

- Validar rangos de fechas.
- Calcular cantidad de dias.
- Consultar disponibilidad de un listing.
- Crear, listar y eliminar bloqueos manuales.
- Evitar solapamientos entre bloqueos manuales.
- Evitar reservas sobre rangos ocupados por reservas activas.
- Exponer `blockingBookingStatuses` para reutilizar el contrato.

Estados de booking que bloquean disponibilidad:

- `ACCEPTED`
- `READY_FOR_PICKUP`
- `IN_PROGRESS`
- `RETURN_PENDING`

Nota de producto:

- `REQUESTED` no bloquea disponibilidad. Esto permite multiples solicitudes por un mismo rango hasta que el owner acepte una. Al aceptar, se vuelve a validar disponibilidad.

### BookingsModule

Archivos:

- `src/bookings/bookings.controller.ts`
- `src/bookings/bookings.service.ts`
- `src/bookings/dto/create-booking.dto.ts`
- `src/bookings/dto/cancel-booking.dto.ts`
- `src/bookings/dto/confirm-token.dto.ts`

Responsabilidades:

- Crear solicitud de reserva.
- Listar reservas propias.
- Ver una reserva como participante.
- Aceptar o rechazar reserva.
- Cancelar reserva.
- Marcar reserva lista para pickup.
- Exponer tokens QR segun rol/estado.
- Confirmar pickup.
- Confirmar return.
- Registrar auditoria en eventos importantes.
- Coordinar pagos mock mediante `PaymentsService`.

Reglas principales:

- El listing debe estar `ACTIVE` para crear reserva.
- El renter no puede reservar su propio listing.
- Fechas invalidas o pasadas se rechazan.
- Reservas activas y bloqueos manuales impiden crear o aceptar una reserva.
- Al aceptar, el booking pasa a `ACCEPTED`, se generan tokens y se crea pago mock `PENDING`.
- No se puede marcar `READY_FOR_PICKUP` sin `paymentStatus = PAID`.
- Pickup solo puede confirmarlo el owner con token correcto.
- Return solo puede confirmarlo el renter con token correcto.
- Al completar return, el booking pasa a `COMPLETED` y se registra release mock.
- Si se cancela una reserva pagada antes del pickup, se simula refund.

Tokens:

- `pickupTokenHash` y `returnTokenHash` guardan hashes con `bcryptjs`.
- `pickupTokenPreview` y `returnTokenPreview` existen temporalmente para que el frontend muestre QR.
- Las previews se limpian al consumir el token.
- Las previews no son el diseno final recomendado para produccion sensible.

### PaymentsModule

Archivos:

- `src/payments/payments.controller.ts`
- `src/payments/payments.service.ts`
- `src/payments/dto/mock-webhook.dto.ts`
- `src/payments/providers/payment-provider.interface.ts`
- `src/payments/providers/mock-payments.provider.ts`

Responsabilidades:

- Crear intent mock para una reserva aceptada.
- Consultar estado de pago por booking.
- Confirmar pago mock.
- Fallar pago mock.
- Reembolsar pago mock.
- Simular webhook fake.
- Registrar release mock al completar reserva.
- Actualizar `PaymentRecord`.
- Actualizar `Booking.paymentStatus`, `paidAt` y `refundedAt`.
- Auditar eventos de pago.

Diseno reemplazable:

- `PaymentProvider` define la frontera interna.
- `MockPaymentsProvider` genera `providerId` fake y metadata.
- `PaymentsService` no deberia saber detalles de Stripe/Mercado Pago cuando se agreguen.
- Los webhooks reales deben mapearse a los mismos eventos de dominio: confirm, fail, refund, release.

Seguridad:

- No se guarda tarjeta.
- No se mueve dinero real.
- Las acciones autenticadas validan que el usuario sea participante de la reserva.
- El webhook mock es una simulacion para desarrollo y no debe exponerse igual en produccion real.

### VerificationModule

Archivos:

- `src/verification/verification.controller.ts`
- `src/verification/verification.service.ts`
- `src/verification/dto/confirm-code.dto.ts`
- `src/verification/dto/submit-identity.dto.ts`

Responsabilidades:

- Solicitar codigo de email.
- Confirmar codigo de email.
- Solicitar codigo de telefono.
- Confirmar codigo de telefono.
- Consultar estado de verificacion propio.
- Enviar metadata de identidad.
- Consultar identidad propia.

Estado actual:

- Verificaciones internas con codigos hasheados.
- No hay proveedor SMS real integrado.
- Identidad se maneja por metadata/URLs, no por verificador externo.

### AdminModule

Archivos:

- `src/admin/admin.controller.ts`
- `src/admin/admin.service.ts`
- DTOs en `src/admin/dto`

Responsabilidades protegidas por `JwtAuthGuard + RolesGuard + @Roles(ADMIN)`:

- Listar usuarios.
- Ver usuario.
- Cambiar estado de usuario.
- Cambiar rol de usuario.
- Listar verificaciones.
- Ver verificacion.
- Revisar verificacion.
- Listar listings.
- Cambiar estado de listing.
- Listar bookings.
- Ver booking.
- Registrar auditoria en acciones relevantes.

DTOs:

- `ReviewVerificationDto`
- `UpdateListingStatusDto`
- `UpdateUserRoleDto`
- `UpdateUserStatusDto`

### MediaModule

Archivos:

- `src/media/media.controller.ts`
- `src/media/media.service.ts`
- `src/media/dto/register-media-asset.dto.ts`

Responsabilidades:

- Registrar metadata de assets externos.
- Listar assets propios.

Estado actual:

- No sube archivos por si mismo.
- No firma uploads.
- No integra SDK de Cloudinary en backend.
- Puede registrar assets subidos fuera del backend, incluyendo `storageProvider: "cloudinary"` y `storageKey` si el frontend o un servicio externo hizo el upload.

Pendiente importante:

- Validar ownership de `entityType/entityId` para impedir que un usuario registre assets sobre entidades ajenas.
- Agregar firma segura para upload directo si se integra Cloudinary desde backend.

### EmailModule

Archivos:

- `src/email/email.module.ts`
- `src/email/email.service.ts`

Responsabilidades:

- Enviar codigo de verificacion.
- Enviar reset password.

Estado actual:

- Usa Gmail SMTP si existen `GMAIL_USER` y `GMAIL_APP_PASSWORD`.
- Si faltan credenciales, el servicio no envia y registra warning.

## 7. Endpoints

### Root

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| GET | `/` | Publico | Root/status basico de la API |

### Auth

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| POST | `/auth/register` | Publico | Registra usuario y devuelve token |
| POST | `/auth/login` | Publico | Login email/password |
| POST | `/auth/verify-email` | JWT | Confirma email con codigo |
| POST | `/auth/resend-verification` | JWT | Reenvia codigo de verificacion |
| POST | `/auth/forgot-password` | Publico | Solicita reset password |
| POST | `/auth/reset-password` | Publico | Confirma reset password |
| GET | `/auth/google` | Publico | Inicia OAuth Google |
| GET | `/auth/google/callback` | Publico/OAuth | Callback OAuth Google |
| POST | `/auth/request-email-change` | JWT | Solicita cambio de email |
| POST | `/auth/confirm-email-change` | JWT | Confirma cambio de email |

### Users

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| GET | `/users/me` | JWT | Perfil propio seguro |
| PATCH | `/users/me` | JWT | Actualiza perfil propio |

### Vehicles

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| POST | `/vehicles` | JWT | Crea vehiculo propio |
| GET | `/vehicles/me` | JWT | Lista vehiculos propios |
| GET | `/vehicles/:id` | Publico | Lee vehiculo publico por id |
| PATCH | `/vehicles/:id` | JWT owner | Actualiza vehiculo propio |
| DELETE | `/vehicles/:id` | JWT owner | Elimina vehiculo propio si no tiene listings |

### Listings

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| POST | `/listings` | JWT owner | Crea listing para vehiculo propio |
| GET | `/listings` | Publico | Catalogo publico activo con filtros |
| GET | `/listings/me` | JWT | Lista listings propios |
| GET | `/listings/:id` | Publico | Obtiene listing activo |
| PATCH | `/listings/:id` | JWT owner | Actualiza listing propio |
| DELETE | `/listings/:id` | JWT owner | Soft delete del listing |
| GET | `/listings/:id/availability` | Publico | Consulta disponibilidad en rango |
| POST | `/listings/:id/availability-blocks` | JWT owner | Crea bloqueo manual |
| GET | `/listings/:id/availability-blocks` | JWT owner | Lista bloqueos manuales |
| DELETE | `/listings/:id/availability-blocks/:blockId` | JWT owner | Elimina bloqueo manual |

Query soportada en catalogo:

- `page`
- `limit`
- `locationText`
- `minPrice`
- `maxPrice`
- `brand`
- `model`
- `startDate`
- `endDate`
- `sort`: `newest`, `priceAsc`, `priceDesc`

### Verification

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| POST | `/verification/email/request` | JWT | Solicita codigo email |
| POST | `/verification/email/confirm` | JWT | Confirma codigo email |
| POST | `/verification/phone/request` | JWT | Solicita codigo phone |
| POST | `/verification/phone/confirm` | JWT | Confirma codigo phone |
| GET | `/verification/me/status` | JWT | Estado propio de verificacion |
| POST | `/verification/identity/submit` | JWT | Envia identidad por metadata |
| GET | `/verification/identity/me` | JWT | Consulta identidad propia |

### Bookings

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| POST | `/bookings` | JWT renter | Solicita reserva |
| GET | `/bookings/me` | JWT | Lista reservas propias como owner o renter |
| GET | `/bookings/:id` | JWT participante | Obtiene reserva |
| PATCH | `/bookings/:id/accept` | JWT owner | Acepta reserva y crea pago mock |
| PATCH | `/bookings/:id/reject` | JWT owner | Rechaza reserva |
| PATCH | `/bookings/:id/cancel` | JWT participante | Cancela reserva si el estado lo permite |
| PATCH | `/bookings/:id/ready-for-pickup` | JWT owner | Marca listo para pickup si pago esta PAID |
| GET | `/bookings/:id/tokens` | JWT participante | Devuelve token correcto segun rol/estado |
| POST | `/bookings/:id/confirm-pickup` | JWT owner | Confirma pickup con token del renter |
| POST | `/bookings/:id/confirm-return` | JWT renter | Confirma return con token del owner |

### Payments

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| POST | `/payments/bookings/:bookingId/mock-intent` | JWT renter | Crea o devuelve intent mock pendiente |
| GET | `/payments/bookings/:bookingId/status` | JWT participante | Consulta estado y records |
| POST | `/payments/bookings/:bookingId/mock-confirm` | JWT participante | Simula pago confirmado |
| POST | `/payments/bookings/:bookingId/mock-fail` | JWT participante | Simula pago fallido |
| POST | `/payments/bookings/:bookingId/mock-refund` | JWT participante | Simula refund |
| POST | `/payments/mock/webhook` | Publico/dev | Webhook fake para desarrollo |

### Media

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| POST | `/media/assets` | JWT | Registra metadata de asset |
| GET | `/media/assets/me` | JWT | Lista assets propios |

### Admin

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| GET | `/admin/users` | JWT ADMIN | Lista usuarios |
| GET | `/admin/users/:id` | JWT ADMIN | Obtiene usuario |
| PATCH | `/admin/users/:id/status` | JWT ADMIN | Cambia estado de usuario |
| PATCH | `/admin/users/:id/role` | JWT ADMIN | Cambia rol de usuario |
| GET | `/admin/verifications` | JWT ADMIN | Lista verificaciones |
| GET | `/admin/verifications/:id` | JWT ADMIN | Obtiene verificacion |
| PATCH | `/admin/verifications/:id/review` | JWT ADMIN | Revisa verificacion |
| GET | `/admin/listings` | JWT ADMIN | Lista listings |
| PATCH | `/admin/listings/:id/status` | JWT ADMIN | Cambia estado de listing |
| GET | `/admin/bookings` | JWT ADMIN | Lista bookings |
| GET | `/admin/bookings/:id` | JWT ADMIN | Obtiene booking |

## 8. Prisma Schema

Datasource:

- Provider: `postgresql`
- URL: `env("DATABASE_URL")`

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
- `createdAt`
- `updatedAt`

Relaciones:

- `vehicles`
- `listings`
- `listingAvailabilityBlocks`
- `verifications`
- `verificationCodes`
- `bookingsAsOwner`
- `bookingsAsRenter`
- `paymentRecords`
- `mediaAssets`
- `auditLogsAsActor`
- `auditLogsAsTarget`

Indices:

- `email`
- `status`
- `verificationStatus`

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
- `bluetooth`
- `rearCamera`
- `parkingSensors`
- `fuelConsumptionLitersPer100Km`
- `doors`
- `trunkCapacityLiters`
- `widthMm`
- `lengthMm`
- `heightMm`
- `weightKg`
- `horsePower`
- `engineDisplacementCC`
- `observations`
- timestamps

Relaciones:

- `owner`
- `listings`
- `bookings`

Indices:

- `ownerId`
- `brand, model`

#### Listing

Publicacion de un vehiculo.

Campos:

- `vehicleId`
- `ownerId`
- `title`
- `description`
- `pricePerDay`
- `locationText`
- `latitude`
- `longitude`
- `deliveryLatitude`
- `deliveryLongitude`
- `deliveryRadiusKm`
- `status`
- timestamps

Relaciones:

- `vehicle`
- `owner`
- `bookings`
- `availabilityBlocks`

Indices:

- `ownerId`
- `vehicleId`
- `status, createdAt`

#### ListingAvailabilityBlock

Bloqueo manual creado por el owner para impedir reservas en un rango.

Campos:

- `listingId`
- `ownerId`
- `startDate`
- `endDate`
- `reason`
- timestamps

Relaciones:

- `listing`
- `owner`

Indices:

- `listingId, startDate, endDate`
- `ownerId`

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
- `pickupTokenPreview`
- `returnTokenPreview`
- `pickupConfirmedAt`
- `returnConfirmedAt`
- `cancelledAt`
- `cancellationReason`
- `paymentStatus`
- `paymentProvider`
- `providerPaymentId`
- `platformFeeSnapshot`
- `depositSnapshot`
- `paidAt`
- `refundedAt`
- timestamps

Relaciones:

- `listing`
- `vehicle`
- `owner`
- `renter`
- `paymentRecords`

Indices:

- `listingId`
- `vehicleId`
- `ownerId`
- `renterId`
- `status`
- `startDate, endDate`

#### PaymentRecord

Registro de intent, confirmacion, fallo, refund o release de pago.

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
- timestamps

Relaciones:

- `booking`
- `user`

Indices:

- `bookingId`
- `userId`
- `status`

#### VerificationCode

Codigo hasheado para email verification, phone verification o password reset.

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
- timestamps

Indices:

- `userId, targetType, consumedAt`
- `expiresAt`

#### UserVerification

Metadata de verificacion de identidad.

Campos:

- `userId`
- `status`
- `documentUrl`
- `selfieUrl`
- `notes`
- `reviewedAt`
- timestamps

Indices:

- `userId`
- `status`

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
- timestamps

Indices:

- `ownerId`
- `entityType, entityId`
- `kind`
- `status`

#### AuditLog

Auditoria de acciones relevantes.

Campos:

- `actorId`
- `targetUserId`
- `action`
- `entityType`
- `entityId`
- `metadata`
- `createdAt`

Indices:

- `actorId`
- `targetUserId`
- `entityType, entityId`
- `action`
- `createdAt`

## 9. Flujos De Dominio

### Flujo De Reserva Actual

1. Renter solicita reserva sobre un listing `ACTIVE`.
2. Backend valida fechas, self-booking, reservas bloqueantes y bloqueos manuales.
3. Booking queda en `REQUESTED`.
4. Owner acepta o rechaza.
5. Al aceptar, backend revalida disponibilidad, genera tokens de pickup/return y crea pago mock `PENDING`.
6. Renter confirma pago mock.
7. Booking queda con `paymentStatus = PAID` y `paidAt`.
8. Owner marca `READY_FOR_PICKUP`.
9. Renter obtiene y muestra QR de pickup.
10. Owner confirma pickup con token.
11. Booking pasa a `IN_PROGRESS`.
12. Owner obtiene y muestra QR de return.
13. Renter confirma return con token.
14. Booking pasa a `COMPLETED`.
15. Backend registra release mock.

### Disponibilidad

Una fecha esta bloqueada si se solapa con:

- Reserva en `ACCEPTED`.
- Reserva en `READY_FOR_PICKUP`.
- Reserva en `IN_PROGRESS`.
- Reserva en `RETURN_PENDING`.
- Bloqueo manual del listing.

No bloquean:

- `REQUESTED`
- `REJECTED`
- `CANCELLED_BY_RENTER`
- `CANCELLED_BY_OWNER`
- `COMPLETED`
- `DISPUTED`, salvo que se decida cambiar la regla de negocio.

### Pago Mock

Estados principales:

- Al aceptar booking: `PaymentRecord.PENDING`, `Booking.paymentStatus = PENDING`.
- Confirmacion mock: `PaymentRecord.PAID`, `Booking.paymentStatus = PAID`, `paidAt`.
- Fallo mock: `PaymentRecord.FAILED`, `Booking.paymentStatus = FAILED`.
- Refund mock: `PaymentRecord.REFUNDED`, `Booking.paymentStatus = REFUNDED`, `refundedAt`.
- Release mock: se crea record/evento de release cuando el booking completa return.

### Cancelacion

Permitida actualmente en:

- `REQUESTED`
- `ACCEPTED`
- `READY_FOR_PICKUP`

Resultado:

- Si cancela renter: `CANCELLED_BY_RENTER`.
- Si cancela owner: `CANCELLED_BY_OWNER`.
- Si ya estaba pagado: se simula refund mock.

### QR Pickup/Return

Pickup:

- Lo muestra el renter.
- Lo confirma el owner.
- Solo se expone cuando el booking esta `READY_FOR_PICKUP`.

Return:

- Lo muestra el owner.
- Lo confirma el renter.
- Se expone cuando el booking esta `IN_PROGRESS` o `RETURN_PENDING`.

## 10. Seguridad

Implementado:

- Passwords hasheados.
- Verification codes hasheados.
- JWT con secret configurable.
- Guards JWT para rutas privadas.
- Roles guard para admin.
- Serializacion segura de usuarios.
- Ownership en vehicles, listings, bookings y availability blocks.
- No almacenamiento de datos de tarjeta.
- Tokens pickup/return hasheados.
- Limpieza de tokens al consumirse.
- Auditoria para acciones importantes.
- ValidationPipe global con whitelist.

Riesgos conocidos:

- `pickupTokenPreview` y `returnTokenPreview` guardan token plano temporal para compatibilidad con QR de frontend.
- `POST /payments/mock/webhook` es simulacion de desarrollo; en produccion real deberia validar firma del provider.
- `MediaAsset` necesita validacion mas estricta de ownership por `entityType/entityId`.
- CORS esta abierto con `origin: true`.
- Falta rate limiting para auth, verification, token confirmation y payment mock.
- Falta observabilidad avanzada y tracing.

## 11. Integraciones

### Neon/PostgreSQL

Uso actual:

- Persistencia principal via Prisma.
- `DATABASE_URL` debe tener SSL si Neon lo requiere.
- Migraciones aplicadas por Prisma Migrate.

Buenas practicas:

- No usar `db push` contra produccion.
- Ejecutar `npm run check:prisma` antes de deploy.
- Revisar migraciones antes de aplicar.
- Mantener indices para consultas frecuentes por owner, listing, status y fechas.

### Vercel

Archivo: `vercel.json`

```json
{
  "version": 2,
  "buildCommand": "prisma migrate deploy && nest build",
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

Notas:

- El handler serverless entra por `api/index.ts`.
- `createServer()` cachea Express/Nest.
- `DATABASE_URL` debe estar disponible durante build porque `buildCommand` ejecuta migraciones.
- `postinstall` ejecuta `prisma generate`.
- `bcryptjs` evita problemas de binarios nativos.

### GitHub

Uso esperado:

- Repositorio remoto y PRs.
- CI futuro para build, test, check:prisma y deploy.
- `gh` o GitHub app pueden usarse para PRs si se activa el flujo de publicacion.

Pendiente recomendado:

- Workflow de GitHub Actions con:
  - install
  - check:env
  - check:prisma
  - build
  - test
  - test:e2e si hay DB de test

### Email/Gmail

Uso actual:

- Emails transaccionales opcionales.
- Si faltan credenciales, no se envia correo real.

Variables:

- `GMAIL_USER`
- `GMAIL_APP_PASSWORD`

### Google OAuth

Uso actual:

- Se habilita solo si existen credenciales.
- Callback resuelve backend desde `API_BASE_URL`, `VERCEL_URL` o localhost.
- Redireccion final usa `FRONTEND_URL`.

### Media/Cloudinary

Estado real del backend:

- El backend no integra Cloudinary SDK ni firma uploads.
- El backend registra metadata de assets por URL.
- Si el frontend sube a Cloudinary, luego debe llamar `POST /media/assets` con `storageProvider`, `storageKey`, `url`, `kind`, `entityType` y `entityId`.

Futuro:

- Endpoint para firmar uploads Cloudinary.
- Validacion de ownership por entidad.
- Borrado/sync de assets.
- Limites por MIME, tamano y cantidad.

## 12. Variables De Entorno

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
API_BASE_URL=""
FRONTEND_URL=""
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

Notas:

- `VERCEL_URL` puede existir inyectada por Vercel aunque no viva en `.env.example`.
- `CORS_ORIGINS` queda por compatibilidad documental; CORS actual no filtra whitelist.
- `TARGET_URL` y `API_BASE_URL` se usan en scripts funcionales y checkers.
- `TEST_EMAIL` y `TEST_PASSWORD` permiten login con usuario existente durante pruebas funcionales.

## 13. Scripts

| Script | Descripcion |
| --- | --- |
| `npm run build` | Compila Nest |
| `npm run format` | Prettier sobre `src/**/*.ts` y `test/**/*.ts` |
| `npm run start` | Inicia Nest |
| `npm run start:dev` | Inicia Nest en watch |
| `npm run start:debug` | Inicia Nest con debugger |
| `npm run start:prod` | Ejecuta `dist/main.js` |
| `npm run lint` | ESLint con fix |
| `npm test` | Jest unit tests |
| `npm run test:e2e` | Jest E2E |
| `npm run test:endpoints:local` | Endpoint checker local |
| `npm run test:endpoints:deployed` | Endpoint checker deploy |
| `npm run test:functional` | Flujo funcional |
| `npm run db:migrate:deploy` | Aplica migraciones Prisma |
| `npm run verify:deployed` | Checker desplegado con reintentos |
| `npm run check:env` | Valida env/docs |
| `npm run check:prisma` | Prisma validate/generate |
| `npm run preflight` | Prisma, build, tests y checker local |
| `npm run commit:smart` | Commit asistido local |
| `postinstall` | `prisma generate` |

## 14. Testing Actual

Suites actuales:

- `app.controller.spec.ts`
- `cors.config.spec.ts`
- Auth service/controller.
- Users service/controller.
- Vehicles service.
- Listings service.
- Availability service.
- Bookings service.
- Payments service.
- Verification service.
- Admin service.
- Prisma service.
- Roles guard.
- E2E base en `test/app.e2e-spec.ts`.

Cobertura funcional del script:

- Root.
- Listings publicos.
- Auth register/login.
- Users me.
- Vehicles CRUD parcial.
- Listings CRUD parcial.
- Disponibilidad.
- Booking owner/renter.
- Pago mock.
- Pickup token.
- Return token.

Limitaciones:

- `preflight` intenta checker local; si no hay server escuchando, informa `fetch failed`.
- `npx tsc --noEmit` puede revelar errores de types en specs antiguos si mocks no incluyen campos nuevos de Prisma.

## 15. Estado Actual Implementado

Implementado:

- Auth local con email/password.
- JWT configurable.
- Password hashing con `bcryptjs`.
- Verificacion de email con codigos hasheados.
- Recuperacion de password con tokens hasheados.
- Cambio de email por codigo.
- Google OAuth opcional.
- Perfil propio y actualizacion.
- CRUD de vehiculos con ownership.
- CRUD/listado de listings.
- Soft delete de listings.
- Filtros, paginacion y sorting en listings.
- Disponibilidad por listing.
- Bloqueos manuales por owner.
- Reservas con estados, snapshots y tokens.
- Pago mock requerido antes de pickup.
- Confirmacion de pickup/return por token.
- Refund mock en cancelaciones pagadas.
- Release mock al completar return.
- Admin para usuarios, verificaciones, listings y bookings.
- Registro de media por URL/metadata.
- Audit logs.
- CORS permisivo.
- Deploy serverless en Vercel.
- Scripts de validacion y pruebas.

## 16. Pendientes Tecnicos Prioritarios

Alta prioridad:

- Reemplazar previews de tokens QR por emision efimera o canal seguro.
- Agregar expiracion, regeneracion e intentos fallidos para tokens pickup/return.
- Validar ownership de `MediaAsset.entityType/entityId`.
- Agregar rate limiting en auth, verification, payment mock y confirmaciones de token.
- Agregar healthcheck dedicado.
- Crear tests E2E reales con DB aislada.
- Corregir mocks antiguos para que `tsc --noEmit` pase completo.

Media prioridad:

- Provider real de pagos.
- Webhooks reales con firma.
- Modelo de fees, deposits, payouts y conciliacion.
- Politicas de cancelacion y penalidades.
- Availability avanzada por calendario recurrente.
- Estados o tabla de disputes.
- Mensajeria renter/owner.
- Notificaciones por email/eventos.
- Observabilidad: logs estructurados, tracing y metricas.

Baja prioridad:

- Politicas finas de CORS por ambiente.
- Busqueda geografica avanzada.
- Reviews/rating.
- Favoritos.
- Promociones o descuentos.
- Backoffice admin mas completo.

## 17. Roadmap De Produccion

### Fase 1 - Robustez Backend

- Healthcheck real.
- Rate limiting.
- Typecheck completo en CI.
- E2E con base de datos de test.
- Hardening de media ownership.
- Mejor manejo de errores y codigos HTTP.
- Seed controlado para desarrollo.

### Fase 2 - Pagos Reales

- Elegir provider: Stripe, Mercado Pago u otro.
- Implementar provider concreto bajo la interfaz actual.
- Webhooks firmados.
- Idempotencia por provider event id.
- Refunds reales.
- Payout/release real al owner.
- Conciliacion de `PaymentRecord`.
- Campos adicionales para fees, deposits y provider metadata.

### Fase 3 - Seguridad Operativa

- Rotacion de secretos.
- Auditoria mas detallada.
- Alertas para eventos sensibles.
- Proteccion anti abuso.
- Caducidad y regeneracion de QR tokens.
- CORS por ambiente si se decide restringir origenes.

### Fase 4 - Producto Marketplace

- Reviews.
- Mensajeria.
- Disputas.
- Penalidades de cancelacion.
- Depositos de garantia.
- Verificacion de identidad con proveedor externo.
- Verificacion SMS real.
- Calendario publico/privado para owners.

### Fase 5 - Observabilidad Y Escala

- Logs estructurados.
- Traces por request.
- Metricas de reservas, pagos y errores.
- Dashboards.
- Indices revisados con datos reales.
- Jobs para limpieza de codigos expirados, tokens y records antiguos.

## 18. Notas Operativas

Desarrollo local:

```bash
npm install
npm run check:prisma
npm run start:dev
```

Validacion normal:

```bash
npm run build
npm test -- --runInBand
npm run check:env
npm run check:prisma
```

Preflight:

```bash
npm run preflight
```

Deploy:

```bash
npm run db:migrate:deploy
npm run build
```

Pruebas funcionales:

```bash
TARGET_URL="http://localhost:3000" npm run test:functional
API_BASE_URL="https://tu-backend.vercel.app" npm run test:functional
```

Reglas operativas:

- No commitear `.env`.
- No usar `db push` en produccion.
- Revisar migraciones antes de deploy.
- Mantener `backend.md` y `README.md` sincronizados cuando cambie un contrato publico.
- Si falla Prisma en Vercel build, revisar `DATABASE_URL` de build.
- Si falla CORS, recordar que el backend actual refleja origen entrante.
- Si falla hashing en serverless, verificar que se use `bcryptjs`, no `bcrypt`.

## 19. Glosario De Dominio

- Owner: usuario que posee vehiculo/listing.
- Renter: usuario que solicita reserva.
- Listing: publicacion alquilable de un vehiculo.
- Booking: reserva o solicitud de reserva.
- Availability block: bloqueo manual de fechas.
- Pickup: entrega/retiro del auto.
- Return: devolucion del auto.
- Mock payment: simulacion de pago sin dinero real.
- Payment release: liberacion simulada del pago al completar reserva.
- Audit log: registro de accion relevante.
