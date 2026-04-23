# FreeWheel Backend

Backend de marketplace de alquiler de autos construido con NestJS, Prisma y PostgreSQL.

## Setup

```bash
npm install
```

Configurá tus variables de entorno a partir de `.env.example`.

## Scripts

```bash
npm run start:dev
npm run build
npm run test
```

## Flujo de autenticación y verificación

### Auth

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/verify-email`
- `POST /auth/resend-email-verification`

### Usuario autenticado

- `GET /users/me`
- `GET /users/me/verification-status`
- `PATCH /users/me/phone`
- `POST /users/me/phone/send-verification`
- `POST /users/me/phone/verify`
- `POST /users/me/identity/document`
- `POST /users/me/identity/request-verification`

## Variables relevantes

- `JWT_SECRET`, `JWT_ACCESS_TOKEN_TTL`, `JWT_REFRESH_TOKEN_TTL`
- `EMAIL_VERIFICATION_TOKEN_TTL_MINUTES`, `EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS`
- `PHONE_VERIFICATION_OTP_TTL_MINUTES`, `PHONE_VERIFICATION_MAX_ATTEMPTS`, `PHONE_VERIFICATION_RESEND_COOLDOWN_SECONDS`
- `IDENTITY_DOCUMENT_MAX_FILE_SIZE_MB`, `IDENTITY_DOCUMENT_ALLOWED_MIME_TYPES`, `LOCAL_UPLOADS_DIR`
- `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`

## Notas

- Si no configurás SendGrid o Twilio, el backend usa providers de desarrollo que registran el token/código en consola.
- Los documentos se almacenan localmente en la carpeta definida por `LOCAL_UPLOADS_DIR`.
- La aprobación o rechazo manual de identidad no se expone todavía vía endpoints públicos, pero el modelo ya quedó preparado.
