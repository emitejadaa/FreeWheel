# FreeWheel

FreeWheel es un backend para un marketplace de alquiler de autos entre usuarios. El flujo actual cubre registro/login, perfil propio, vehiculos propios, listings asociados a vehiculos y consulta publica de listings activos.

El proyecto prioriza seguridad, mantenibilidad, ownership claro y pruebas automatizadas antes de ampliar funcionalidades sensibles como verificacion de identidad, mensajeria, reservas o pagos.

## Stack

- NestJS 11
- TypeScript
- Prisma 6
- PostgreSQL, con Neon como opcion esperada para base remota
- JWT con `@nestjs/jwt` y `passport-jwt`
- bcrypt
- class-validator y class-transformer
- Jest
- npm con `package-lock.json`

## Requisitos

- Node.js compatible con NestJS 11. CI usa Node 22.
- npm
- PostgreSQL accesible mediante `DATABASE_URL`

## Variables de Entorno

Crear un `.env` local tomando como base `.env.example`. No commitear secretos.

Variables requeridas:

```env
DATABASE_URL="postgresql://user:password@host:5432/freewheel?sslmode=require"
JWT_SECRET="replace-with-a-secure-secret"
```

Variables opcionales documentadas:

```env
DIRECT_URL=""
JWT_EXPIRES_IN="24h"
PORT=3000
LOCAL_API_URL="http://localhost:3000"
RENDER_API_URL=""
TARGET_URL=""
FRONTEND_URL=""
CORS_ORIGINS=""
API_BASE_URL=""
TEST_EMAIL=""
TEST_PASSWORD=""
FUNCTIONAL_TEST_TIMEOUT_MS=10000
SENDGRID_API_KEY=""
TWILIO_ACCOUNT_SID=""
TWILIO_AUTH_TOKEN=""
```

`SENDGRID_*` y `TWILIO_*` son placeholders para sprints futuros. No hay integracion activa si el codigo no la implementa.

## Instalacion

```bash
npm install
```

El `postinstall` ejecuta `prisma generate`.

## Desarrollo Local

```bash
npm run start:dev
```

Base local por defecto:

```txt
http://localhost:3000
```

## Prisma

Validar Prisma y regenerar cliente:

```bash
npm run check:prisma
```

Crear migracion local despues de revisar cambios de schema:

```bash
npx prisma migrate dev
```

No usar `db push` ni migraciones destructivas contra produccion sin confirmacion explicita.

## Tests y Checks

```bash
npm run build
npm test
npm run check:env
npm run check:prisma
npm run preflight
```

`npm run preflight` ejecuta Prisma, build, tests y luego intenta el checker local. El checker local requiere que el servidor este corriendo.

## Probar Endpoints Locales

Con el backend levantado:

```bash
npm run test:endpoints:local
```

Configurable con:

```bash
LOCAL_API_URL="http://localhost:3000"
```

El script descubre rutas de controllers y prueba endpoints publicos criticos sin autenticacion: `GET /` y `GET /listings`. No inventa tokens, usuarios ni IDs para rutas privadas o dependientes de datos.

## Probar Render

Definir la URL remota:

```bash
RENDER_API_URL="https://tu-servicio.onrender.com"
```

Luego ejecutar:

```bash
npm run test:endpoints:render
```

No hay URL hardcodeada. Si `RENDER_API_URL` falta, el script falla y explica que debe configurarse.

## Deploy en Render

La configuracion versionada esta en `render.yaml`.

Build command:

```bash
npm ci && npm run build
```

Start command:

```bash
npm run render:start
```

`render:start` ejecuta `prisma migrate deploy` antes de levantar Nest. Render debe tener configuradas como minimo:

```env
DATABASE_URL="postgresql://..."
JWT_SECRET="..."
JWT_EXPIRES_IN="24h"
FRONTEND_URL="https://tu-front.vercel.app"
```

Si `POST /auth/register` o `POST /auth/login` devuelven `500`, revisar primero env vars y migraciones remotas.

`FRONTEND_URL` habilita CORS para el frontend desplegado. Para permitir varios origenes, usar `CORS_ORIGINS` con valores separados por coma, por ejemplo `https://front-a.vercel.app,https://front-b.vercel.app`.

## Probar Flujo Frontend-Backend Funcional

Para validar una URL local o deployada usando solo funcionalidades implementadas:

```bash
TARGET_URL="http://localhost:3000" npm run test:functional
TARGET_URL="https://tu-api.onrender.com" npm run test:functional
FRONTEND_URL="https://tu-front.vercel.app" API_BASE_URL="https://tu-api.onrender.com" npm run test:functional
```

Opcionalmente se pueden usar credenciales de prueba existentes:

```bash
TEST_EMAIL="e2e-user@example.com" TEST_PASSWORD="TestPassword123!" API_BASE_URL="https://tu-api.onrender.com" npm run test:functional
```

El reporte muestra funcionalidades detectadas, pruebas ejecutadas, `PASS`, `FAIL`, `SKIP`, errores HTTP, validacion, autenticacion, conexion y CORS. Si register/login existen y no se pasan credenciales, crea un usuario falso unico con datos `e2e-test-*`. No prueba pagos, email/SMS, admin, mensajeria, reservas ni funcionalidades futuras si no existen en codigo.

## Verificar Despues de Push o Deploy

```bash
npm run verify:render
```

Este comando reintenta de forma limitada contra `RENDER_API_URL`. No confirma por si mismo que Render haya terminado el deploy; solo verifica la URL disponible. Variables opcionales:

```env
RENDER_VERIFY_ATTEMPTS=5
RENDER_VERIFY_DELAY_MS=15000
```

## Skills y Tools del Proyecto

Las guias estan en `docs/skills/`:

- `test-local-endpoints`: smoke test local de endpoints publicos.
- `test-render-endpoints`: smoke test remoto usando `RENDER_API_URL`.
- `deploy-verification`: verificacion remota con reintentos limitados.
- `frontend-backend-functional-test`: testing funcional local/deploy de flujos frontend-backend existentes.
- `smart-commit`: helper para revisar diff y crear commits convencionales.
- `project-preflight`: checks generales antes/despues de cambios importantes.
- `env-checker`: validacion de `.env.example` y variables requeridas.
- `prisma-safety-check`: validacion Prisma sin migraciones destructivas.

## Commits

Usar Conventional Commits:

```txt
feat(auth): add email verification endpoint
fix(prisma): correct listing relation
test(api): add local endpoint healthcheck
docs(agents): document endpoint testing workflow
chore(render): add deploy verification script
```

Helper:

```bash
npm run commit:smart
git add <related-files>
npm run commit:smart -- --commit "docs(agents): update workflow"
```

El helper revisa cambios, bloquea archivos sensibles obvios, corre build/tests y commitea solo archivos ya stageados.

## CI

Existe un workflow en `.github/workflows/ci.yml` que corre:

- `npm ci`
- `npm run check:prisma`
- `npm run build`
- `npm test -- --runInBand`
- `npm run check:env`
- `npm run test:endpoints:render` solo si existe el secret `RENDER_API_URL`

Para activar el check remoto, configurar `RENDER_API_URL` como secret del repo.

## Endpoints

El contrato actual esta documentado en `ENDPOINTS.md`. Si un endpoint no esta documentado, revisar primero los controllers en `src/**/**.controller.ts` antes de asumir que existe.

## Estado Actual

Implementado:

- Auth con register/login y JWT.
- Perfil propio.
- CRUD de vehiculos propios con ownership.
- CRUD de listings con soft delete y consulta publica de activos.
- Scripts de validacion local, Render, env, Prisma, preflight y commit helper.

Proximos pasos recomendados:

- Agregar healthcheck explicito si Render necesita una ruta dedicada.
- Mantener `ENDPOINTS.md` actualizado con cada cambio de contrato.
- Antes de identidad, pagos o mensajeria, definir decisiones de producto y proveedores.
