# Flujo de Auth, Verificación e Identidad

Esta guía explica el flujo actual del backend para registro, login, verificación de email, verificación de teléfono y solicitud de verificación de identidad.

## Base URL

En local:

```text
http://localhost:3000
```

## Requisitos previos

- Tener el backend corriendo con `npm run start:dev`
- Tener `DATABASE_URL` configurada correctamente en `.env`
- Haber aplicado las migraciones de Prisma sobre tu base
- Si no configuraste SendGrid o Twilio todavía, dejar la terminal abierta para ver el código de email y el OTP por consola

## Autenticación

Los endpoints protegidos requieren:

```http
Authorization: Bearer <accessToken>
```

## Resumen del flujo recomendado

1. Registrar usuario
2. Verificar email
3. Hacer login
4. Cargar teléfono
5. Enviar OTP por SMS
6. Verificar teléfono
7. Subir documento
8. Solicitar verificación de identidad
9. Consultar el perfil y revisar estados

## Política actual del sistema

- El usuario se crea al registrarse, aunque el email no esté verificado
- El login está permitido aunque `emailVerified` sea `false`
- El perfil expone claramente el estado parcial de la cuenta
- La identidad verificada no es automática
- `isFullyVerified` solo es `true` cuando `identityVerificationStatus` es `VERIFIED`

## Estados importantes

### Verificación de contacto

- `emailVerified`: confirma acceso al correo
- `phoneVerified`: confirma acceso al teléfono

### Verificación de identidad

Valores de `identityVerificationStatus`:

- `UNVERIFIED`
- `PENDING_REVIEW`
- `VERIFIED`
- `REJECTED`

## Endpoints disponibles

### 1. Registrar usuario

**POST** `/auth/register`

Crea el usuario y dispara la verificación de email.

Body JSON:

```json
{
  "email": "test1@example.com",
  "password": "Password1",
  "firstName": "Juan",
  "lastName": "Perez",
  "birthDate": "1995-06-15"
}
```

Respuesta esperada:

```json
{
  "message": "Cuenta creada correctamente. Revisa tu email para verificar la cuenta.",
  "data": {
    "user": {
      "id": "uuid",
      "email": "test1@example.com",
      "emailVerified": false,
      "phoneNumber": null,
      "phoneVerified": false,
      "identityVerificationStatus": "UNVERIFIED",
      "isFullyVerified": false
    }
  }
}
```

Notas:

- El email debe ser único
- La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número

### 2. Verificar email

**POST** `/auth/verify-email`

Confirma el email usando el código de 6 dígitos generado por el backend.

Body JSON:

```json
{
  "token": "123456"
}
```

Si SendGrid no está configurado:

- el código se imprime en la consola del backend
- buscá un mensaje parecido a:

```text
[EMAIL:DEV] Verification email for test1@example.com. Code: 123456
```

### 3. Reenviar verificación de email

**POST** `/auth/resend-email-verification`

Body JSON:

```json
{
  "email": "test1@example.com"
}
```

Notas:

- Tiene cooldown para evitar abuso
- La respuesta es genérica para no filtrar información sensible

### 4. Login

**POST** `/auth/login`

Body JSON:

```json
{
  "email": "test1@example.com",
  "password": "Password1"
}
```

Respuesta esperada:

```json
{
  "message": "Login exitoso.",
  "data": {
    "accessToken": "jwt_access_token",
    "refreshToken": "refresh_token",
    "user": {
      "id": "uuid",
      "email": "test1@example.com",
      "emailVerified": true,
      "phoneNumber": null,
      "phoneVerified": false,
      "identityVerificationStatus": "UNVERIFIED",
      "isFullyVerified": false
    }
  }
}
```

Guardá:

- `accessToken` para endpoints protegidos
- `refreshToken` para renovar sesión o logout

### 5. Refresh token

**POST** `/auth/refresh`

Body JSON:

```json
{
  "refreshToken": "refresh_token_actual"
}
```

Devuelve un nuevo `accessToken` y un nuevo `refreshToken`.

### 6. Logout

**POST** `/auth/logout`

Body JSON:

```json
{
  "refreshToken": "refresh_token_actual"
}
```

Revoca el refresh token actual.

### 7. Obtener perfil actual

**GET** `/users/me`

Requiere Bearer token.

Devuelve un resumen completo del estado de la cuenta:

```json
{
  "data": {
    "id": "uuid",
    "email": "test1@example.com",
    "emailVerified": true,
    "emailVerifiedAt": "2026-04-23T18:00:00.000Z",
    "phoneNumber": "+5491112345678",
    "phoneVerified": true,
    "phoneVerifiedAt": "2026-04-23T18:10:00.000Z",
    "identityVerificationStatus": "PENDING_REVIEW",
    "identityVerificationRequestedAt": "2026-04-23T18:20:00.000Z",
    "identityVerifiedAt": null,
    "identityVerificationRejectedAt": null,
    "identityVerificationRejectionReason": null,
    "hasUploadedIdentityDocument": true,
    "uploadedIdentityDocuments": [
      {
        "id": "uuid",
        "side": "FRONT",
        "uploadedAt": "2026-04-23T18:15:00.000Z"
      }
    ],
    "isFullyVerified": false
  }
}
```

### 8. Obtener estado de verificación

**GET** `/users/me/verification-status`

Requiere Bearer token.

Actualmente devuelve lo mismo que `/users/me`.

### 9. Cargar o actualizar teléfono

**PATCH** `/users/me/phone`

Requiere Bearer token.

Body JSON:

```json
{
  "phoneNumber": "+5491112345678"
}
```

Notas:

- El número debe venir en formato internacional válido
- Si cambia el número, se pierde la verificación previa

### 10. Enviar OTP al teléfono

**POST** `/users/me/phone/send-verification`

Requiere Bearer token.

Body: vacío

Si Twilio no está configurado:

- el OTP se imprime en la consola del backend
- buscá un mensaje parecido a:

```text
[SMS:DEV] Verification SMS for +5491112345678. Code: 123456
```

### 11. Verificar teléfono con OTP

**POST** `/users/me/phone/verify`

Requiere Bearer token.

Body JSON:

```json
{
  "code": "123456"
}
```

Notas:

- El OTP expira
- Tiene límite de intentos
- Tiene cooldown para reenvío

### 12. Subir documento de identidad

**POST** `/users/me/identity/document`

Requiere Bearer token.

Usa `multipart/form-data`.

Campo requerido:

- `file`: archivo de imagen

Tipos aceptados por defecto:

- `image/jpeg`
- `image/png`
- `image/webp`

Ejemplo con `curl`:

```bash
curl -X POST http://localhost:3000/users/me/identity/document \
  -H "Authorization: Bearer <accessToken>" \
  -F "file=@C:/ruta/documento-frente.jpg"
```

Notas:

- El storage actual es local y privado
- Se guarda metadata del archivo
- No se expone una ruta pública insegura

### 13. Solicitar verificación de identidad

**POST** `/users/me/identity/request-verification`

Requiere Bearer token.

Body: vacío

Precondiciones obligatorias:

- `emailVerified = true`
- `phoneVerified = true`
- al menos un documento subido

Si todo está correcto:

- `identityVerificationStatus` pasa a `PENDING_REVIEW`

## Cómo probarlo paso a paso

### Opción 1: Thunder Client

Crear una colección llamada `FreeWheel Auth`.

Configurar una variable de entorno opcional:

```text
baseUrl = http://localhost:3000
```

Orden recomendado:

1. `POST {{baseUrl}}/auth/register`
2. `POST {{baseUrl}}/auth/verify-email`
3. `POST {{baseUrl}}/auth/login`
4. Guardar `accessToken`
5. `GET {{baseUrl}}/users/me`
6. `PATCH {{baseUrl}}/users/me/phone`
7. `POST {{baseUrl}}/users/me/phone/send-verification`
8. `POST {{baseUrl}}/users/me/phone/verify`
9. `POST {{baseUrl}}/users/me/identity/document`
10. `POST {{baseUrl}}/users/me/identity/request-verification`
11. `GET {{baseUrl}}/users/me`

Para endpoints protegidos:

- abrir pestaña `Auth`
- elegir `Bearer`
- pegar el `accessToken`

Para subida de archivo:

- ir a `Body`
- elegir `Form`
- agregar una key `file`
- marcarla como `File`
- seleccionar la imagen

### Opción 2: curl

#### Registrar

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"test1@example.com\",\"password\":\"Password1\",\"firstName\":\"Juan\",\"lastName\":\"Perez\",\"birthDate\":\"1995-06-15\"}"
```

#### Verificar email

```bash
curl -X POST http://localhost:3000/auth/verify-email \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"123456\"}"
```

#### Login

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"test1@example.com\",\"password\":\"Password1\"}"
```

#### Actualizar teléfono

```bash
curl -X PATCH http://localhost:3000/users/me/phone \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d "{\"phoneNumber\":\"+5491112345678\"}"
```

#### Enviar OTP

```bash
curl -X POST http://localhost:3000/users/me/phone/send-verification \
  -H "Authorization: Bearer <accessToken>"
```

#### Verificar OTP

```bash
curl -X POST http://localhost:3000/users/me/phone/verify \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"123456\"}"
```

#### Solicitar verificación de identidad

```bash
curl -X POST http://localhost:3000/users/me/identity/request-verification \
  -H "Authorization: Bearer <accessToken>"
```

## Qué pasa si no configuraste SendGrid o Twilio

Podés seguir usando la app en local.

Comportamiento actual:

- si no hay `SENDGRID_API_KEY`, el backend imprime el código de verificación de email en consola
- si no hay credenciales de Twilio, el backend imprime el OTP en consola

Esto permite probar todo el flujo sin integrar todavía proveedores reales.

## Errores frecuentes

### `401 Unauthorized`

Posibles causas:

- `accessToken` inválido
- token vencido
- credenciales incorrectas en login
- API key inválida en SendGrid o Twilio

### `400 Bad Request`

Posibles causas:

- código de email inválido o expirado
- OTP inválido o expirado
- teléfono faltante
- documento faltante
- precondiciones de identidad no cumplidas

### `409 Conflict`

Posibles causas:

- email ya registrado
- teléfono ya asociado a otra cuenta

### `429 Too Many Requests`

Posibles causas:

- reenvío de email demasiado rápido
- reenvío de OTP demasiado rápido

## Verificación exitosa del flujo

Al final del recorrido esperado, `/users/me` debería reflejar:

- `emailVerified = true`
- `phoneVerified = true`
- `hasUploadedIdentityDocument = true`
- `identityVerificationStatus = "PENDING_REVIEW"`
- `isFullyVerified = false`

Esto es correcto porque la aprobación manual final todavía no está implementada por endpoint público.
