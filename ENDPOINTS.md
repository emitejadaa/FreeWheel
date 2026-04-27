# FreeWheel API - Endpoints funcionales actuales

Base URL local:

```txt
http://localhost:3000
```

Las rutas protegidas requieren JWT en el header:

```http
Authorization: Bearer <accessToken>
```

## Auth

### Registrar usuario

```http
POST /auth/register
```

Body:

```json
{
  "email": "user@example.com",
  "password": "123456",
  "firstName": "Juan",
  "lastName": "Perez"
}
```

Notas:

- El email debe ser valido y unico.
- La password debe tener minimo 6 caracteres.
- La password se guarda hasheada con bcrypt.
- La respuesta no devuelve password.

Respuesta esperada:

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "firstName": "Juan",
    "lastName": "Perez",
    "phone": null,
    "role": "USER",
    "status": "ACTIVE",
    "createdAt": "2026-04-27T00:00:00.000Z",
    "updatedAt": "2026-04-27T00:00:00.000Z"
  },
  "accessToken": "jwt"
}
```

### Login

```http
POST /auth/login
```

Body:

```json
{
  "email": "user@example.com",
  "password": "123456"
}
```

Respuesta esperada:

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "firstName": "Juan",
    "lastName": "Perez",
    "phone": null,
    "role": "USER",
    "status": "ACTIVE",
    "createdAt": "2026-04-27T00:00:00.000Z",
    "updatedAt": "2026-04-27T00:00:00.000Z"
  },
  "accessToken": "jwt"
}
```

## Users

### Ver mi usuario

```http
GET /users/me
```

Auth: requerida.

Respuesta esperada:

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "firstName": "Juan",
  "lastName": "Perez",
  "phone": null,
  "role": "USER",
  "status": "ACTIVE",
  "createdAt": "2026-04-27T00:00:00.000Z",
  "updatedAt": "2026-04-27T00:00:00.000Z"
}
```

### Actualizar mi usuario

```http
PATCH /users/me
```

Auth: requerida.

Body:

```json
{
  "firstName": "Juan Pablo",
  "lastName": "Perez",
  "phone": "+5491112345678"
}
```

Todos los campos son opcionales. No permite modificar email, password, role ni status desde este endpoint.

## Vehicles

### Crear vehiculo

```http
POST /vehicles
```

Auth: requerida.

Body:

```json
{
  "brand": "Toyota",
  "model": "Corolla",
  "year": 2020,
  "plate": "AB123CD",
  "color": "Gris",
  "seats": 5,
  "transmission": "AUTOMATIC",
  "fuelType": "GASOLINE"
}
```

Campos requeridos:

- `brand`
- `model`
- `year`

Campos opcionales:

- `plate`
- `color`
- `seats`
- `transmission`: `MANUAL` o `AUTOMATIC`
- `fuelType`: `GASOLINE`, `DIESEL`, `HYBRID`, `ELECTRIC`, `OTHER`

### Listar mis vehiculos

```http
GET /vehicles/me
```

Auth: requerida.

Devuelve solo los vehiculos del usuario autenticado.

### Ver vehiculo por id

```http
GET /vehicles/:id
```

Auth: no requerida.

Ejemplo:

```http
GET /vehicles/vehicle-uuid
```

### Actualizar vehiculo

```http
PATCH /vehicles/:id
```

Auth: requerida.

Solo el duenio del vehiculo puede actualizarlo.

Body:

```json
{
  "color": "Negro",
  "seats": 5
}
```

Todos los campos del body son opcionales y siguen las mismas validaciones que al crear.

### Eliminar vehiculo

```http
DELETE /vehicles/:id
```

Auth: requerida.

Solo el duenio del vehiculo puede eliminarlo.

Decision actual: el borrado de vehiculos es real, pero se bloquea si el vehiculo tiene listings asociados. Esto evita romper relaciones.

Respuesta esperada:

```json
{
  "deleted": true
}
```

## Listings

### Crear listing

```http
POST /listings
```

Auth: requerida.

Para crear un listing, el `vehicleId` debe existir y pertenecer al usuario autenticado.

Body:

```json
{
  "vehicleId": "vehicle-uuid",
  "title": "Toyota Corolla en excelente estado",
  "description": "Auto comodo para ciudad y ruta.",
  "pricePerDay": 45000,
  "locationText": "Palermo, CABA",
  "latitude": -34.5808,
  "longitude": -58.4261,
  "status": "ACTIVE"
}
```

Campos requeridos:

- `vehicleId`
- `title`
- `description`
- `pricePerDay`
- `locationText`

Campos opcionales:

- `latitude`
- `longitude`
- `status`: `DRAFT`, `ACTIVE`, `PAUSED`, `DELETED`

Si no se envia `status`, Prisma usa `DRAFT` por defecto.

### Listar listings publicos activos

```http
GET /listings
```

Auth: no requerida.

Devuelve solamente listings con:

```txt
status = ACTIVE
```

### Listar mis listings

```http
GET /listings/me
```

Auth: requerida.

Devuelve todos los listings del usuario autenticado.

### Ver listing por id

```http
GET /listings/:id
```

Auth: no requerida.

No devuelve listings con `status = DELETED`.

Ejemplo:

```http
GET /listings/listing-uuid
```

### Actualizar listing

```http
PATCH /listings/:id
```

Auth: requerida.

Solo el duenio del listing puede actualizarlo.

Body:

```json
{
  "title": "Toyota Corolla automatico",
  "pricePerDay": 50000,
  "status": "PAUSED"
}
```

Si se cambia `vehicleId`, el nuevo vehiculo tambien debe pertenecer al usuario autenticado.

### Eliminar listing

```http
DELETE /listings/:id
```

Auth: requerida.

Solo el duenio del listing puede eliminarlo.

Decision actual: el borrado de listings es soft delete. El registro queda guardado con:

```txt
status = DELETED
```

## Errores comunes

### Token faltante o invalido

```json
{
  "message": "Unauthorized",
  "statusCode": 401
}
```

### Recurso ajeno

```json
{
  "message": "You cannot update this vehicle",
  "error": "Forbidden",
  "statusCode": 403
}
```

### Recurso inexistente

```json
{
  "message": "Vehicle not found",
  "error": "Not Found",
  "statusCode": 404
}
```

### Email duplicado

```json
{
  "message": "Email already registered",
  "error": "Conflict",
  "statusCode": 409
}
```

## Flujo recomendado para probar

1. Registrar usuario con `POST /auth/register`.
2. Copiar el `accessToken`.
3. Crear vehiculo con `POST /vehicles`.
4. Crear listing con `POST /listings` usando el `id` del vehiculo.
5. Ver listings activos con `GET /listings`.
6. Probar ownership intentando modificar solo recursos propios.

## Variables de entorno necesarias

```env
DATABASE_URL="postgresql://user:password@host:5432/freewheel?sslmode=require"
JWT_SECRET="cambiar-por-un-secreto-seguro"
JWT_EXPIRES_IN="24h"
```

## Comandos utiles

```bash
npm install
npx prisma generate
npx prisma migrate dev
npm run start:dev
```
