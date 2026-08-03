# FreeWheel Backend

Documento maestro del backend de FreeWheel. Describe el contexto del proyecto, arquitectura, estructura de carpetas, modulos NestJS, endpoints, modelos Prisma, flujos de dominio, integraciones, scripts, estado actual, riesgos conocidos y roadmap tecnico.

## 1. Contexto Del Proyecto

FreeWheel es un backend NestJS para un marketplace de alquiler de autos entre usuarios. El producto permite que un owner publique vehiculos y que un renter solicite reservas en fechas concretas. El sistema ya cubre autenticacion, usuarios, vehiculos, listings, disponibilidad, reservas, pagos mock, conversaciones, verificacion, administracion, media metadata, auditoria y despliegue serverless en Vercel.

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

- Separar dominio por modulos NestJS: auth, users, vehicles, listings, availability, bookings, payments, conversations, media, verification, admin, email, prisma y common.
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
  preflight.ts                     Corre Prisma, build y checker local
  prisma-check.ts                  Valida schema y ejecuta prisma generate
  smart-commit.ts                  Script local de commit asistido
  test-functional.ts               Flujo funcional multiendpoint

src/
  admin/                           Operaciones administrativas protegidas por ADMIN
  auth/                            Register, login, JWT, OAuth, email verification, password reset
  availability/                    Disponibilidad y bloqueos manuales por listing
  bookings/                        Ciclo de reserva y tokens pickup/return
  common/                          Guards, decorators, tipos, utils, constantes y servicios comunes
  config/                          Helpers de URLs publicas
  conversations/                   Chat entre renter y owner por listing
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
  helpers/                         Helpers de test (app, db, email fake, factory)
  *.e2e-spec.ts                    Specs E2E por dominio
  jest-global-setup.ts             Carga .env.test, guard de seguridad y migrate
  setup-env.ts                     Carga .env.test por worker
  tsconfig.json                    tsconfig de los specs

jest.config.js                     Config Jest (E2E)
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
- `ConversationsModule`

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
- Loguea conexion/desconexion; un fallo al conectar se registra y se relanza en `onModuleInit`.

### CommonModule

Archivos:

- `src/common/common.module.ts`
- `src/common/decorators/current-user.decorator.ts`
- `src/common/decorators/roles.decorator.ts`
- `src/common/guards/roles.guard.ts`
- `src/common/services/audit-log.service.ts`
- `src/common/types/current-user.type.ts`
- `src/common/filters/all-exceptions.filter.ts`
- `src/common/utils/verification-code.util.ts`
- `src/common/utils/entity.util.ts`
- `src/common/utils/authorization.util.ts`
- `src/common/constants/prisma-select.ts`

Recursos:

- `@CurrentUser()`: obtiene el usuario autenticado desde request.
- `@Roles(...)`: declara roles requeridos.
- `RolesGuard`: valida roles contra metadata.
- `AuditLogService`: crea registros en `AuditLog`.
- `CurrentUserPayload`: tipo comun de usuario autenticado.
- `AllExceptionsFilter`: filtro global de excepciones (registrado en `app.factory`). Loguea metodo, ruta, usuario y stack en 5xx; preserva las respuestas HTTP nativas de Nest y no loguea headers ni body.
- `consumeVerificationCode`, `generateNumericCode`, `generateOpaqueToken`: helpers compartidos de codigos/tokens (`utils/verification-code.util.ts`). `consumeVerificationCode` unifica la confirmacion (find, expiry, intentos, compare, consume) usada por auth y verification, con factories de error por flujo para preservar status codes.
- `assertFound`: narrowing + 404 reutilizable (`utils/entity.util.ts`).
- `assertOwner` y `assertParticipant`: chequeos de autorizacion reutilizables (`utils/authorization.util.ts`).
- `USER_PUBLIC_SELECT`, `USER_CONTACT_SELECT`, `USER_SAFE_SELECT`, `BOOKING_PARTICIPANT_INCLUDE`: shapes Prisma compartidos (`constants/prisma-select.ts`).

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

- Registro de usuarios en dos pasos con email verificado ANTES de crear la cuenta: `register/start` (envia codigo, no crea usuario) y `register/complete` (valida codigo + payload y crea la cuenta ya email-verificada). No existe fila `User` hasta confirmar el codigo.
- Fecha de nacimiento obligatoria (mayores de 18) validada en el servidor (`@IsAdultDate`). Para cuentas de Google/legacy sin fecha, `complete-profile` la completa.
- Login email/password. Si el email no esta verificado o falta la fecha de nacimiento, no emite `accessToken`: devuelve un `onboardingToken` de alcance acotado y un flag (`emailVerificationRequired` / `profileCompletionRequired`).
- Emision de JWT completo y de `onboardingToken` (scope `onboarding`, corto).
- Verificacion de email de cuentas legacy y reenvio.
- Solicitud y confirmacion de cambio de email.
- Forgot/reset password.
- Google OAuth opcional (auto-verifica email; si falta la fecha de nacimiento redirige con `pending=complete_profile`).
- Bloqueo de login para usuarios suspendidos o eliminados.

DTOs:

- `RegisterStartDto`
- `RegisterCompleteDto`
- `CompleteProfileDto`
- `LoginDto`
- `VerifyEmailDto`
- `ForgotPasswordDto`
- `ResetPasswordDto`

Estrategias:

- `JwtStrategy`: usa `JWT_SECRET`. Rechaza tokens con `scope` (fail-closed) y expone `verificationStatus` y `dateOfBirth` en el request.
- `JwtOnboardingStrategy` (`jwt-onboarding`): acepta solo tokens con `scope: "onboarding"`; habilita los endpoints de onboarding via `OnboardingAuthGuard`.
- `GoogleStrategy`: se registra solo si existen `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.

Verificacion de cuenta para acciones sensibles:

- `VerifiedAccountGuard` + `@RequireVerifiedAccount()` bloquean con 403 (`code: ACCOUNT_NOT_VERIFIED`) las mutaciones sensibles (reservas, pagos, aceptar contrato, crear/editar vehiculos y listings) salvo cuentas totalmente verificadas (`verificationStatus === VERIFIED`). Ver, mensajear y editar perfil quedan libres.

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
- `src/payments/pricing.service.ts`
- `src/payments/providers/payment-provider.interface.ts`
- `src/payments/providers/stripe-payments.provider.ts`
- `src/payments/providers/mock-payments.provider.ts`

Responsabilidades:

- Calcular montos del lado del servidor (`PricingService`): seña, saldo, seguro, comisión, depósito, payout del owner (en unidades mínimas/centavos).
- Crear PaymentIntents de seña y saldo, y el hold de garantía (captura manual).
- Procesar webhooks de Stripe firmados, idempotentes por `event.id` (tabla `StripeEvent`).
- Liquidar al check-out: liberar (o capturar) el hold y transferir el payout al owner (Connect).
- Reembolsar seña/saldo y liberar el hold en cancelaciones.
- Onboarding del owner como cuenta conectada (Connect).
- Actualizar `PaymentRecord` (ledger) y `Booking.paymentStatus`, `paidAt`, `refundedAt`, `ownerTransferId`.

Diseno reemplazable:

- `PaymentProvider` define la frontera interna (intents, hold/capture/release, refund, transfer, connect, webhook).
- `StripePaymentsProvider` (real, solo claves `sk_test_…`) y `MockPaymentsProvider` (determinista/offline) la implementan; se elige por `PAYMENTS_PROVIDER`.
- Modelo Stripe Connect con *separate charges & transfers*: el payout al owner se transfiere al completar la reserva.

Seguridad:

- No se guarda tarjeta (PaymentIntents; el front tokeniza con Stripe.js).
- Solo modo test: el provider Stripe rechaza arrancar con claves live (`sk_live_`/`rk_live_`).
- Montos calculados en el servidor; idempotency keys en cada operación; firma de webhook verificada sobre el raw body.
- Las acciones autenticadas validan que el usuario sea participante de la reserva.

### VerificationModule

Archivos:

- `src/verification/verification.controller.ts`
- `src/verification/verification.service.ts`
- `src/verification/dto/confirm-code.dto.ts`
- `src/verification/dto/submit-identity.dto.ts`
- `src/verification/dto/upload-signature.dto.ts`
- `src/verification/identity/identity-documents.service.ts`
- `src/verification/extraction/barcode-decoder.service.ts` (zxing-wasm: PDF417 + QR)
- `src/verification/extraction/document-ocr.service.ts` (texto impreso via Groq)
- `src/verification/extraction/dni-pdf417.parser.ts`
- `src/verification/extraction/mrz-td1.parser.ts`
- `src/verification/extraction/license-code.parser.ts`
- `src/verification/extraction/extraction.types.ts`
- `src/verification/matching/normalize.util.ts`
- `src/verification/matching/identity-match.service.ts`
- `src/verification/review/identity-reviewer.interface.ts`
- `src/verification/review/identity-review.service.ts`
- `src/verification/review/document-ai.reviewer.ts`
- `src/verification/review/auto-approve.reviewer.ts`
- `src/verification/review/manual.reviewer.ts`

Responsabilidades:

- Solicitar/confirmar codigo de email (entregado por `EmailService`).
- Solicitar/confirmar codigo de telefono (entregado por `SmsService`).
- Consultar estado propio con checklist derivado (`emailVerified`, `phoneVerified`, `documentsSubmitted`, `dateOfBirthProvided`, `identityDataProvided`), `fullyVerified` y `lastReview` (outcome + reason codes).
- Firmar la subida de cada documento por separado (documento + lado), forzando carpeta, `public_id` y entrega privada.
- Recibir los cuatro documentos (DNI y licencia, frente y dorso) validando que cada URL sea un asset propio del slot correcto.
- Revisar los documentos y decidir: extraccion determinista (PDF417 del DNI, QR de la licencia, MRZ con digitos verificadores) + OCR del texto impreso + cruce contra los datos de la cuenta.
- Reintentar la revision de una solicitud pendiente.
- Tras cada evento dispara `IdentityReviewService.evaluate`: si el checklist esta completo, el revisor configurado decide.

Estado actual:

- Verificaciones internas con codigos hasheados.
- Codigos numericos con RNG criptografico y TTL de 10 minutos (constante compartida con la verificacion de email de `AuthModule`).
- El codigo no se devuelve en la respuesta HTTP; en entornos no productivos se loguea para pruebas manuales.
- SMS via `SmsModule` con interfaz de proveedor (`SMS_PROVIDER`); solo el provider `mock` (loguea el codigo) esta implementado. Un proveedor real (Twilio, etc.) se agrega sin tocar callers.
- Revision documental real implementada (`IDENTITY_REVIEW_MODE=document_ai`), con veredicto de tres estados.

Diseno reemplazable:

- Seam `IdentityReviewer` (`IDENTITY_REVIEWER`) elegido por `IDENTITY_REVIEW_MODE`:
  - `document_ai`: revision real (produccion). Falla al arrancar si faltan `CLOUDINARY_*` o `GROQ_API_KEY`.
  - `manual`: nada se aprueba solo; decide un admin.
  - `auto_approve` (default): aprueba todo. Solo desarrollo y tests.
- Puertos de extraccion inyectables y fakeables: `BarcodeDecoderService` (determinista, zxing-wasm) y `DocumentOcrService` (probabilistico, Groq). Cambiar de proveedor de OCR (Claude, Google Vision) toca un solo archivo.
- `IdentityMatchService` es puro (sin IO): toda la politica de decision vive ahi y se testea con una matriz de casos.

Seguridad:

- Los documentos se suben como `type=authenticated`: sus URLs sin firma devuelven 401. La base guarda la URL canonica sin firma; las URLs firmadas se generan al momento y solo para admins.
- El `public_id` lo arma el servidor a partir del JWT (`identity/<userId>/<documento>_<lado>_...`), asi que un usuario no puede subir a la carpeta de otro ni cruzar un documento de slot.
- El submit valida cloud, tipo de entrega, prefijo de carpeta, slot y existencia real del asset antes de aceptar una URL.
- Antifraude: `User.dni`/`User.cuil` son unicos, y la aprobacion revalida dentro de la transaccion que el documento no verifique ya otra cuenta.
- Minimizacion de datos (Ley 25.326): el usuario solo ve codigos de motivo; los datos extraidos y el reporte de cruces quedan para admins y nunca entran en `AuditLog`.
- Los campos que respaldan la identidad (`firstName`, `lastName`, `dni`, `cuil`, `address`) quedan inmutables una vez `VERIFIED`.

Pendiente:

- Verificacion facial con prueba de vida (liveness): captura por camara con tareas guiadas al crear la cuenta, y re-chequeo al iniciar sesion en un dispositivo nuevo o ante acciones de alta sensibilidad. La columna `UserVerification.selfieUrl` queda reservada para esto.
- Politica de retencion/purga del JSON `extracted` (datos personales) pasados N dias de la decision.
- Un cambio legitimo de nombre despues de verificar requiere intervencion de un admin.

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
- `src/media/cloudinary.service.ts`
- `src/media/dto/register-media-asset.dto.ts`
- `src/media/dto/sign-upload.dto.ts`

Responsabilidades:

- Firmar uploads a Cloudinary (el API secret nunca sale del backend; el archivo va directo del cliente a Cloudinary, sin pasar por el limite de body de Vercel).
- `CloudinaryService`: firma multi-parametro, chequeo de existencia via Admin API, URLs de entrega firmadas y descarga server-side de assets privados.
- Registrar metadata de assets externos y listar assets propios.

Estado actual:

- No sube archivos por si mismo: solo firma y valida.
- Integracion hand-rolled sobre `fetch` + `crypto` (sin SDK), mismo idioma que el proxy de Groq. Si la firma de entrega diera problemas contra la cuenta real, se cambia por el SDK oficial tocando solo `cloudinary.service.ts`.
- `POST /media/cloudinary-signature` firma media publica (perfil, vehiculos, publicaciones) y **rechaza la carpeta `identity/`**: los documentos de identidad tienen su propio endpoint, que ademas los sube como privados.

Pendiente importante:

- Validar ownership de `entityType/entityId` para impedir que un usuario registre assets sobre entidades ajenas.

### ConversationsModule

Archivos:

- `src/conversations/conversations.controller.ts`
- `src/conversations/conversations.service.ts`
- `src/conversations/conversations.module.ts`
- DTOs en `src/conversations/dto`

Responsabilidades:

- Crear o reutilizar una conversacion entre renter y owner para un listing.
- Listar conversaciones propias como renter u owner.
- Obtener una conversacion si el usuario participa.
- Listar mensajes de una conversacion.
- Enviar mensajes `TEXT` o `AUDIO`.
- Marcar mensajes entrantes como leidos.

Reglas:

- Un renter no puede iniciar conversacion sobre su propia publicacion.
- Solo se crean conversaciones nuevas si el listing esta `ACTIVE`.
- La unicidad `listingId + renterId` evita chats duplicados para el mismo renter/listing.
- Solo renter u owner de la conversacion pueden leer o escribir mensajes.

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
| POST | `/auth/register/start` | Publico | Paso 1: envia codigo al email (no crea usuario) |
| POST | `/auth/register/complete` | Publico | Paso 2: valida codigo + payload (con `dateOfBirth`) y crea la cuenta |
| POST | `/auth/login` | Publico | Login email/password; devuelve `onboardingToken` si falta verificar email o fecha de nacimiento |
| POST | `/auth/complete-profile` | Onboarding/JWT | Completa la fecha de nacimiento (18+) y devuelve token completo |
| POST | `/auth/verify-email` | Onboarding/JWT | Confirma email (cuentas legacy) |
| POST | `/auth/resend-verification` | Onboarding/JWT | Reenvia codigo de verificacion |
| POST | `/auth/forgot-password` | Publico | Solicita reset password |
| POST | `/auth/reset-password` | Publico | Confirma reset password |
| GET | `/auth/google` | Publico | Inicia OAuth Google |
| GET | `/auth/google/callback` | Publico/OAuth | Callback OAuth Google (redirige a completar perfil si falta fecha de nacimiento) |
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
| GET | `/verification/me/status` | JWT | Estado propio + checklist (`fullyVerified`, `lastReview`) |
| POST | `/verification/identity/upload-signature` | JWT | Firma la subida de UN documento (`document` + `side`) |
| POST | `/verification/identity/submit` | JWT | Envia DNI y licencia (frente/dorso) por URL y dispara la revision |
| POST | `/verification/identity/review-retry` | JWT | Reintenta la revision de la solicitud pendiente |
| GET | `/verification/identity/me` | JWT | Solicitudes propias (sin URLs ni datos extraidos) |

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
| POST | `/payments/bookings/:bookingId/sena-intent` | JWT renter | Crea/reusa el PaymentIntent de la seña (30%) |
| POST | `/payments/bookings/:bookingId/balance-intent` | JWT renter | PaymentIntent del saldo (requiere seña pagada) |
| POST | `/payments/bookings/:bookingId/deposit-hold` | JWT renter | PaymentIntent de garantía con captura manual (hold) |
| GET | `/payments/bookings/:bookingId/status` | JWT participante | Estado de pago, montos y records |
| POST | `/payments/connect/onboarding` | JWT owner | Crea la cuenta conectada (Connect) del owner |
| POST | `/payments/stripe/webhook` | Publico (firma) | Webhook de Stripe; firma verificada sobre el raw body |

### Contracts

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| GET | `/contracts/bookings/:bookingId` | JWT participante | Contrato digital de la reserva (terms) |
| GET | `/contracts/bookings/:bookingId/pdf` | JWT participante | Contrato en PDF |
| POST | `/contracts/bookings/:bookingId/accept` | JWT participante | Registra la aceptación de cada parte |

### Media

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| POST | `/media/assets` | JWT | Registra metadata de asset |
| GET | `/media/assets/me` | JWT | Lista assets propios |

### Conversations

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| POST | `/conversations` | JWT renter | Crea o reutiliza conversacion para un listing |
| GET | `/conversations/me` | JWT | Lista conversaciones propias |
| GET | `/conversations/:id` | JWT participante | Obtiene conversacion |
| GET | `/conversations/:id/messages` | JWT participante | Lista mensajes |
| POST | `/conversations/:id/messages` | JWT participante | Envia mensaje |
| PATCH | `/conversations/:id/read` | JWT participante | Marca mensajes entrantes como leidos |

### Admin

| Metodo | Ruta | Auth | Descripcion |
| --- | --- | --- | --- |
| GET | `/admin/users` | JWT ADMIN | Lista usuarios |
| GET | `/admin/users/:id` | JWT ADMIN | Obtiene usuario |
| PATCH | `/admin/users/:id/status` | JWT ADMIN | Cambia estado de usuario |
| PATCH | `/admin/users/:id/role` | JWT ADMIN | Cambia rol de usuario |
| GET | `/admin/verifications` | JWT ADMIN | Lista verificaciones |
| GET | `/admin/verifications/:id` | JWT ADMIN | Obtiene verificacion |
| GET | `/admin/verifications/:id/documents` | JWT ADMIN | Documentos con URLs firmadas + extraccion y cruces (auditado) |
| PATCH | `/admin/verifications/:id/review` | JWT ADMIN | Revisa verificacion |
| GET | `/admin/listings` | JWT ADMIN | Lista listings |
| PATCH | `/admin/listings/:id/status` | JWT ADMIN | Cambia estado de listing |
| DELETE | `/admin/listings/:id` | JWT ADMIN | Elimina permanentemente un listing |
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
- `MessageType`: `TEXT`, `AUDIO`

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
- `conversationsAsRenter`
- `conversationsAsOwner`
- `sentMessages`

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
- `conversations`

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

#### Conversation

Chat entre un renter y el owner de un listing.

Campos:

- `listingId`
- `renterId`
- `ownerId`
- `lastMessageAt`
- timestamps

Relaciones:

- `listing`
- `renter`
- `owner`
- `messages`

Indices:

- unico `listingId, renterId`
- `renterId`
- `ownerId`
- `lastMessageAt`

#### Message

Mensaje dentro de una conversacion.

Campos:

- `conversationId`
- `senderId`
- `type`
- `content`
- `readAt`
- `createdAt`

Relaciones:

- `conversation`
- `sender`

Indices:

- `conversationId`
- `senderId`

## 9. Flujos De Dominio

### Verificacion De Identidad (document_ai)

Objetivo: que el titular de una cuenta verificada sea una persona real, mayor
de edad y habilitada para conducir. Es el requisito para todas las acciones
sensibles (`VerifiedAccountGuard`).

Pasos:

1. El usuario carga a mano en su perfil `dni`, `cuil` y `address`
   (`PATCH /users/me`). El CUIL se valida con checksum mod-11 y debe contener
   el DNI informado.
2. Por cada documento y lado pide una firma
   (`POST /verification/identity/upload-signature` con `document` + `side`).
   El servidor devuelve `folder=identity/<userId>`,
   `public_id=<documento>_<lado>_<epoch>_<nonce>` y `type=authenticated`.
3. El cliente sube el archivo directo a Cloudinary con esos parametros.
4. Envia las cuatro URLs (`POST /verification/identity/submit`). El backend
   valida cloud, tipo de entrega, carpeta, slot y existencia de cada asset;
   persiste la URL canonica sin firma y crea la solicitud en `ID_SUBMITTED`.
5. Si el checklist esta completo (email + telefono + fecha de nacimiento +
   datos de identidad + 4 documentos), corre la revision:
   - descarga las cuatro imagenes desde el almacenamiento privado;
   - decodifica el **PDF417** del frente del DNI (fuente autoritativa) y el
     **QR/PDF417** del dorso de la licencia, reintentando con variantes de la
     imagen (ampliada, escala de grises);
   - lee el **texto impreso** de los cuatro lados con OCR, que ademas
     clasifica que documento/lado es cada foto;
   - parsea el **MRZ** del dorso del DNI y valida sus digitos verificadores
     (respaldo autoritativo cuando el PDF417 no se pudo leer);
   - cruza todo entre si y contra los datos de la cuenta.
6. Veredicto (tres estados):
   - **approved**: solicitud y usuario pasan a `VERIFIED`.
   - **rejected**: hay una contradiccion concluyente (nombre, apellido, numero
     de documento o fecha de nacimiento distintos; menor de 18; DNI o licencia
     vencidos; CUIL invalido o de otro DNI; foto en el slot equivocado).
     Solicitud y usuario quedan `REJECTED`; el usuario reenvia documentos.
   - **inconclusive**: no se pudo leer algo o hay una senal debil (codigo
     ilegible, domicilio escrito distinto, PDF417 y MRZ que se contradicen,
     timeout del proveedor). La solicitud **queda `ID_SUBMITTED`** para la cola
     de admins y el usuario puede reintentar con
     `POST /verification/identity/review-retry`.

Criterio de fondo: un dato que no se pudo leer nunca rechaza a una persona
real; deriva a revision humana. Solo rechaza automaticamente lo que se leyo
bien y no coincide.

Cruces que se evaluan (fuentes: PDF417, MRZ, OCR de cada lado, codigo de la
licencia y datos de la cuenta):

| Chequeo | Falla concluyente | Ilegible |
| --- | --- | --- |
| Fuente autoritativa presente (PDF417 o MRZ valido) | - | manual |
| Documento/lado correcto por slot | rechaza | manual |
| Numero de documento (todas las fuentes + cuenta) | rechaza | manual |
| Apellido / primer nombre | rechaza | manual |
| Fecha de nacimiento | rechaza | manual |
| Mayor de 18 al dia de hoy | rechaza | manual |
| DNI vigente (vencimiento del MRZ u OCR) | rechaza | manual |
| Licencia vigente | rechaza | manual |
| Licencia del mismo titular que el DNI | rechaza | manual |
| CUIL: checksum y DNI embebido | rechaza | manual |
| CUIL: prefijo vs sexo, CUIL impreso | manual | manual |
| Sexo (PDF417 vs MRZ vs OCR) | manual | manual |
| Domicilio (similitud de tokens) | manual (nunca rechaza) | manual |
| PDF417 vs MRZ en desacuerdo | manual (nunca aprueba) | - |
| Codigo QR de la licencia | informativo | informativo |

Antifraude: `User.dni` y `User.cuil` son unicos, la aprobacion revalida dentro
de la transaccion que el documento no verifique ya otra cuenta, y los campos
que respaldan la identidad quedan inmutables una vez `VERIFIED`.

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

### Pago Stripe (modo test)

Estados principales (`Booking.paymentStatus` y `PaymentRecord.status` por `kind`):

- Al aceptar: snapshots congelados, contrato creado, `Booking.paymentStatus = PENDING`.
- Seña pagada (webhook `payment_intent.succeeded`): record `SENA` → `CAPTURED`, `Booking.paymentStatus = DEPOSIT_PAID`.
- Saldo pagado: record `BALANCE` → `CAPTURED`; con seña y saldo pagados → `Booking.paymentStatus = FULLY_PAID`.
- Hold de garantía autorizado (webhook `payment_intent.amount_capturable_updated`): record `DEPOSIT_HOLD` → `AUTHORIZED`.
- Check-out (`confirm-return`): hold `RELEASED` (o capturado por daños) y `OWNER_TRANSFER` → `PAID` (transfer al owner).
- Cancelación: refunds de seña/saldo (`REFUND`), hold liberado, `Booking.paymentStatus = REFUNDED`.

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

### Conversaciones

1. Renter abre o reutiliza conversacion con `POST /conversations` enviando `listingId`.
2. Backend valida que el listing exista, este activo para conversaciones nuevas y no pertenezca al renter.
3. Se crea `Conversation` con `renterId`, `ownerId` y `listingId`, o se devuelve la existente.
4. Renter y owner pueden listar sus conversaciones con `GET /conversations/me`.
5. Cualquier participante puede enviar mensajes con `POST /conversations/:id/messages`.
6. Los mensajes entrantes pueden marcarse como leidos con `PATCH /conversations/:id/read`.

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
- Control de participante en conversaciones y mensajes.
- Auditoria para acciones importantes.
- ValidationPipe global con whitelist.
- Filtro global de errores (`AllExceptionsFilter`) con logging de contexto sin filtrar secretos.
- Rate limiting global (`ThrottlerGuard`, 120 req/min/IP) con limites mas bajos por ruta en lo que llama a servicios externos pagos: firma de documentos (10/5min), submit de identidad (5/15min), reintento de revision (3/15min) y proxy de IA (chat 20/min, vision 10/min).
- Proxy de IA (`/ai/chat`, `/ai/vision`) detras de `JwtAuthGuard`: cada request consume cuota de una API key nuestra.
- Documentos de identidad privados en Cloudinary (`type=authenticated`): la URL persistida no sirve para verlos y las URLs firmadas se generan al momento, solo para admins y con auditoria.
- Documentos ligados estructuralmente a su dueno y a su slot: el `public_id` lo arma el servidor desde el JWT y el submit rechaza URLs ajenas, de otro slot o inexistentes. La carpeta `identity/` esta vedada en el endpoint de media generico.
- Antifraude de identidad: `User.dni` y `User.cuil` unicos, revalidacion del documento dentro de la transaccion de aprobacion, e inmutabilidad de los campos de identidad una vez `VERIFIED`.
- Minimizacion de datos personales (Ley 25.326) en la verificacion: el usuario solo recibe codigos de motivo; la extraccion y el reporte de cruces quedan para admins y nunca entran en `AuditLog` ni en los logs.

Riesgos conocidos:

- `pickupTokenPreview` y `returnTokenPreview` guardan token plano temporal para compatibilidad con QR de frontend.
- `POST /payments/mock/webhook` es simulacion de desarrollo; en produccion real deberia validar firma del provider.
- `MediaAsset` necesita validacion mas estricta de ownership por `entityType/entityId`.
- CORS esta abierto con `origin: true`.
- `JWT_SECRET` cae a un valor por defecto interno si no esta seteado (deuda de seguridad); configurar la variable en cada entorno y luego pasar a fail-fast.
- Falta rate limiting especifico para auth y confirmacion de tokens de booking.
- La verificacion documental no prueba que quien sube los documentos sea su titular: falta la verificacion facial con prueba de vida (ver Pendientes).
- El JSON `extracted` guarda datos personales sin politica de retencion/purga.
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
SMS_PROVIDER="mock"
ONBOARDING_JWT_EXPIRES_IN="30m"
# Verificacion de identidad: document_ai (produccion) | manual | auto_approve
IDENTITY_REVIEW_MODE="auto_approve"
IDENTITY_REVIEW_TIMEOUT_MS=45000
# Requeridas por IDENTITY_REVIEW_MODE=document_ai (falla al arrancar sin ellas)
GROQ_API_KEY=""
CLOUDINARY_CLOUD_NAME=""
CLOUDINARY_API_KEY=""
CLOUDINARY_API_SECRET=""
PAYMENTS_PROVIDER="mock"
STRIPE_SECRET_KEY=""
STRIPE_PUBLISHABLE_KEY=""
STRIPE_WEBHOOK_SECRET=""
STRIPE_API_VERSION=""
STRIPE_CONNECT_ENABLED="true"
PLATFORM_FEE_PCT="0.10"
INSURANCE_PCT="0.10"
SENA_PCT="0.30"
DEPOSIT_DEFAULT_USD="200"
DEFAULT_CURRENCY="usd"
```

Notas de pagos:

- `PAYMENTS_PROVIDER` elige `stripe` (real, solo claves `sk_test_…`) o `mock` (offline). El provider Stripe rechaza arrancar con claves live.
- `STRIPE_WEBHOOK_SECRET` valida la firma del webhook; la ruta `/payments/stripe/webhook` recibe el raw body (configurado en `app.factory`).
- Los porcentajes son fracciones (`0.10` = 10%). Montos calculados en el servidor en unidades mínimas (centavos).

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
| `npm test` | Suite E2E (Jest + Supertest, serial) |
| `npm run test:watch` | Suite E2E en watch |
| `npm run test:cov` | Suite E2E con cobertura |
| `npm run test:endpoints:local` | Endpoint checker local |
| `npm run test:endpoints:deployed` | Endpoint checker deploy |
| `npm run test:functional` | Flujo funcional |
| `npm run db:migrate:deploy` | Aplica migraciones Prisma |
| `npm run verify:deployed` | Checker desplegado con reintentos |
| `npm run check:env` | Valida env/docs |
| `npm run check:prisma` | Prisma validate/generate |
| `npm run preflight` | Prisma, build y checker local |
| `npm run commit:smart` | Commit asistido local |
| `postinstall` | `prisma generate` |

## 14. Testing

Suite E2E con Jest + Supertest que ejercita los endpoints reales (routing, guards JWT/roles, `ValidationPipe`, `AllExceptionsFilter` y queries Prisma) contra una base de datos de test dedicada. Es el tipo de test que detecta roturas al cambiar codigo o desplegar.

Estructura:

- `jest.config.js` (raiz): config Jest; corre serial (`--runInBand`) porque los specs comparten la misma base.
- `test/tsconfig.json`: tsconfig de los specs (extiende el base).
- `test/jest-global-setup.ts`: carga `.env.test`, exige `ALLOW_DB_RESET=true` (guard de seguridad) y corre `prisma migrate deploy`.
- `test/setup-env.ts`: carga `.env.test` en cada worker antes de importar la app.
- `test/helpers/`: `app.ts` (boot del app con `EmailService` fake y `configureApp`), `email.fake.ts` (captura codigos/tokens), `db.ts` (`cleanDatabase` en orden FK-safe), `factory.ts` (`registerUser`/`createAdmin`/`createVehicle`/`createListing`).
- `test/*.e2e-spec.ts`: health, auth, users, vehicles, listings, bookings, payments, conversations, verification, admin.

Cobertura: cada endpoint con happy-path + guards (401/403) + validacion (400) + errores clave; mas dos flujos completos:

- Ciclo de booking: request → accept → pago mock → ready-for-pickup → confirm-pickup → confirm-return → `COMPLETED`.
- Ciclo de auth: register → verify-email → login → forgot/reset-password → email-change.

Base de datos de test:

- Requiere `.env.test` (gitignored) apuntando a una branch de Neon DESCARTABLE. Ver `.env.test.example`.
- La suite borra todas las tablas entre tests; el guard `ALLOW_DB_RESET=true` impide correr contra dev/prod.

Comandos:

```bash
npm test            # corre la suite E2E (serial)
npm run test:watch  # modo watch
npm run test:cov    # con cobertura
```

CI: `.github/workflows/test.yml` levanta un Postgres de servicio, corre migraciones y ejecuta la suite en cada push/PR.

Herramientas operativas (no-Jest) que se conservan:

- `scripts/test-functional.ts`: flujo funcional multiendpoint contra un server corriendo.
- `scripts/endpoint-checker/*`: checkers local/deploy con reintentos.
- `npm run preflight`: Prisma validate/generate + build + checker local.

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
- Conversaciones y mensajes renter/owner por listing.
- Admin para usuarios, verificaciones, listings y bookings.
- Delete permanente de listings desde admin.
- Registro de media por URL/metadata.
- Audit logs.
- CORS permisivo.
- Deploy serverless en Vercel.
- Scripts de validacion y pruebas.

## 16. Pendientes Tecnicos Prioritarios

Alta prioridad:

- **Verificacion facial con prueba de vida (liveness).** La verificacion
  documental prueba que los documentos son validos, coherentes entre si y
  consistentes con la cuenta, pero no que quien los subio sea su titular
  (alguien podria usar fotos de documentos ajenos). Diseno previsto: captura
  por camara con una serie de tareas guiadas (girar la cabeza, parpadear,
  repetir una frase) al crear la cuenta, guardando el descriptor facial; y
  re-chequeo al iniciar sesion desde un dispositivo nuevo o antes de una
  accion de alta sensibilidad. La columna `UserVerification.selfieUrl` esta
  reservada para esto y el cruce documental ya deja el hueco donde
  engancharlo.
- Politica de retencion/purga del JSON `extracted` (datos personales) pasados
  N dias de la decision.
- Reemplazar previews de tokens QR por emision efimera o canal seguro.
- Agregar expiracion, regeneracion e intentos fallidos para tokens pickup/return.
- Validar ownership de `MediaAsset.entityType/entityId`.
- Agregar rate limiting en auth y confirmaciones de token de booking.
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
- Mejoras de mensajeria: adjuntos, moderacion y notificaciones.
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
