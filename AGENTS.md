# AGENTS.md - FreeWheel

## Proyecto

FreeWheel es una plataforma backend para un marketplace de alquiler de autos entre usuarios. El sistema debe ser seguro, escalable y facil de mantener. Las areas sensibles incluyen autenticacion, verificacion de usuarios, publicaciones de vehiculos, mensajeria futura, pagos futuros, disputas, privacidad y administracion.

Flujo actual:

- Un usuario se registra o inicia sesion.
- El usuario consulta y actualiza su perfil.
- El usuario carga y administra sus vehiculos.
- El usuario publica listings asociados a sus propios vehiculos.
- Otros usuarios consultan listings activos.
- Las acciones privadas usan JWT y reglas de ownership.

## Fuentes de Verdad

Antes de modificar codigo, revisar solo lo necesario y priorizar:

1. Codigo local: `src/`, `prisma/schema.prisma`, `package.json`, `ENDPOINTS.md`.
2. `README.md`, `docs/skills/` y este `AGENTS.md`.
3. Figma `FreeWheel` si esta disponible o el usuario provee URL/fileKey.
4. Neon Postgres `freewheel` si hace falta validar base real.
5. Render `freewheel` si hace falta revisar deploy, logs o runtime.
6. Vercel `freewheel` si existe frontend o integraciones.
7. GitHub `freewheel` para issues, PRs, CI e historial.

No inventar detalles de conectores externos. Si una herramienta no esta disponible o no tiene permisos suficientes, decirlo y trabajar con el codigo local.

## Stack Detectado

- NestJS 11
- TypeScript
- Prisma 6
- PostgreSQL
- JWT con `@nestjs/jwt` y `passport-jwt`
- bcrypt
- class-validator y class-transformer
- ConfigModule global
- Jest
- npm con `package-lock.json`

## Objetivos del Backend

- Mantener una base limpia, simple y extensible.
- Proteger rutas privadas con JWT.
- Validar ownership en services antes de editar o borrar recursos.
- No exponer passwords, tokens ni secretos.
- Mantener contratos HTTP consistentes con `ENDPOINTS.md`.
- Agregar funcionalidades futuras de forma incremental y documentada.

## Reglas Principales para Agentes

- No inventar funcionalidades, endpoints, credenciales, URLs ni decisiones de negocio.
- Preguntar al usuario cuando una decision afecte seguridad, pagos, privacidad, roles, verificacion de identidad, base de datos o infraestructura.
- Si un endpoint no esta documentado, buscarlo en controllers/routes antes de asumirlo.
- Si no hay URL de Render definida, pedirla o leerla desde `RENDER_API_URL` o documentacion existente.
- Si faltan credenciales o variables, indicar cuales faltan sin inventarlas.
- Hacer cambios pequenos, coherentes y faciles de revisar.
- Revisar archivos existentes antes de crear nuevos patrones.
- No borrar codigo funcional sin explicar el motivo.
- No ejecutar acciones destructivas sin confirmacion explicita.

## Flujo de Trabajo Obligatorio

1. Entender la tarea.
2. Revisar el codigo y documentacion relevante.
3. Definir un plan breve si el cambio es sustancial.
4. Implementar cambios minimos y coherentes.
5. Ejecutar checks locales disponibles.
6. Probar endpoints locales si la tarea afecta API.
7. Probar Render si la tarea afecta deploy o si se pidio verificacion remota.
8. Crear commits claros cuando el cambio este completo y el usuario lo pida o el flujo lo requiera.
9. Reportar exactamente que cambio, que se probo y que falta.

## Skills/Tools del Proyecto

Usar estas skills automaticamente cuando sean utiles:

- `project-preflight`: antes de cambios grandes o antes de cerrar una tarea importante. Comando: `npm run preflight`.
- `test-local-endpoints`: para cambios de API local. Comando: `npm run test:endpoints:local`.
- `test-render-endpoints`: para validar Render con `RENDER_API_URL`. Comando: `npm run test:endpoints:render`.
- `frontend-backend-functional-test`: para validar una URL local/deployada desde el flujo frontend-backend usando solo funcionalidades existentes. Comando: `npm run test:functional`.
- `deploy-verification`: despues de push/deploy cuando haya que verificar remoto. Comando: `npm run verify:render`.
- `smart-commit`: para revisar diff y crear commits Conventional Commits. Comando: `npm run commit:smart`.
- `env-checker`: para cambios de env, deploy u onboarding. Comando: `npm run check:env`.
- `prisma-safety-check`: para cambios de schema/migraciones/base. Comando: `npm run check:prisma`.

Guias detalladas: `docs/skills/`.

## Testing Obligatorio

- Ejecutar `npm run build` para cambios de backend TypeScript.
- Ejecutar `npm test` si se toca logica, guards, services, controllers o DTOs.
- Ejecutar `npm run check:prisma` si se toca Prisma o base de datos.
- Ejecutar `npm run check:env` si se tocan variables, deploy o documentacion de setup.
- Ejecutar `npm run test:endpoints:local` para cambios de API, con servidor local corriendo.
- Ejecutar `npm run test:functional` cuando cambien endpoints, DTOs, auth/guards, llamadas frontend-backend, o cuando se valide una URL hosteada con `TARGET_URL`, `FRONTEND_URL` o `API_BASE_URL`.
- Ejecutar `npm run test:endpoints:render` o `npm run verify:render` para cambios que puedan afectar Render.
- Si un test falla, reportar el error real y no ocultarlo.

## Seguridad

- Proteger rutas privadas con `JwtAuthGuard`.
- Usar `CurrentUser` para el usuario autenticado.
- No confiar en `ownerId` recibido por body.
- Validar ownership en services.
- Mantener `ValidationPipe` con `whitelist` y `forbidNonWhitelisted`.
- No devolver passwords ni secretos.
- Nunca loguear passwords, tokens, `DATABASE_URL`, `JWT_SECRET` ni credenciales.
- No agregar proveedores de email, SMS, storage, pagos o identidad sin decision explicita del usuario.

## Variables de Entorno

Mantener `.env.example` actualizado con placeholders, no secretos reales.

Requeridas hoy:

```env
DATABASE_URL="postgresql://user:password@host:5432/freewheel?sslmode=require"
JWT_SECRET="replace-with-a-secure-secret"
```

Opcionales documentadas:

```env
DIRECT_URL=""
JWT_EXPIRES_IN="24h"
PORT=3000
LOCAL_API_URL="http://localhost:3000"
RENDER_API_URL=""
TARGET_URL=""
FRONTEND_URL=""
API_BASE_URL=""
TEST_EMAIL=""
TEST_PASSWORD=""
FUNCTIONAL_TEST_TIMEOUT_MS=10000
SENDGRID_API_KEY=""
TWILIO_ACCOUNT_SID=""
TWILIO_AUTH_TOKEN=""
```

`SENDGRID_*` y `TWILIO_*` son placeholders para sprints futuros; no asumir integracion activa.

## Prisma y Base de Datos

- Si cambia `prisma/schema.prisma`, ejecutar `npm run check:prisma`.
- Crear migracion local con `npx prisma migrate dev` solo despues de revisar impacto.
- No ejecutar migraciones destructivas sin confirmacion.
- No hacer `prisma db push` contra produccion sin confirmacion explicita.
- Mantener relaciones explicitas, indices utiles y ownership claro.

## Endpoints Actuales

Contrato documentado en `ENDPOINTS.md`.

Publicos:

- `GET /`
- `POST /auth/register`
- `POST /auth/login`
- `GET /listings`
- `GET /listings/:id`
- `GET /vehicles/:id`

Protegidos:

- `GET /users/me`
- `PATCH /users/me`
- `POST /vehicles`
- `GET /vehicles/me`
- `PATCH /vehicles/:id`
- `DELETE /vehicles/:id`
- `POST /listings`
- `GET /listings/me`
- `PATCH /listings/:id`
- `DELETE /listings/:id`

Los checkers automaticos no inventan tokens ni IDs. Solo prueban rutas publicas criticas sin setup.

## Render

- Usar `RENDER_API_URL`.
- No hardcodear URL.
- Mantener `render.yaml` alineado con `package.json`.
- El start remoto recomendado es `npm run render:start`, que ejecuta `prisma migrate deploy` antes de `npm run start:prod`.
- Render debe tener `DATABASE_URL` y `JWT_SECRET` configuradas como variables secretas.
- Verificar healthcheck si existe y endpoints publicos.
- Si Render falla, reportar status, error y posibles causas: deploy caido, env vars faltantes, migraciones pendientes, errores Prisma, endpoint inexistente o server sin escuchar en el puerto correcto.
- No prometer que un deploy termino si no se puede confirmar. `npm run verify:render` solo verifica la URL remota disponible.

## Commits

Usar Conventional Commits:

- `feat(scope): description`
- `fix(scope): description`
- `test(scope): description`
- `docs(scope): description`
- `chore(scope): description`
- `refactor(scope): description`

Antes de commitear:

- Revisar `git diff`.
- No commitear `.env`, secretos ni temporales.
- Detectar cambios de lockfile y `package.json`.
- Ejecutar checks razonables.
- Si los checks fallan, no commitear automaticamente salvo pedido explicito.

Helper:

```bash
npm run commit:smart
git add <related-files>
npm run commit:smart -- --commit "docs(agents): document endpoint testing workflow"
```

## Skill: frontend-backend-functional-test

Usar automaticamente cuando:

- cambien endpoints, controllers, services, DTOs, guards o auth;
- cambien llamadas HTTP del frontend al backend;
- se haga deploy o se pida validar una URL hosteada;
- se quiera comprobar que frontend y backend conectan correctamente.

Variables:

```env
TARGET_URL=""
FRONTEND_URL=""
API_BASE_URL=""
TEST_EMAIL=""
TEST_PASSWORD=""
FUNCTIONAL_TEST_TIMEOUT_MS=10000
```

Ejemplos:

```bash
TARGET_URL="http://localhost:3000" npm run test:functional
TARGET_URL="https://tu-api.onrender.com" npm run test:functional
FRONTEND_URL="https://tu-front.vercel.app" API_BASE_URL="https://tu-api.onrender.com" npm run test:functional
```

Interpretacion del reporte:

- `PASS`: funcionalidad existente respondio como se esperaba.
- `FAIL`: una prueba real fallo; revisar detalle HTTP, validacion, auth, CORS, server o conexion.
- `SKIP`: la funcionalidad no existe, es opcional o faltan credenciales validas.

No usar esta skill para pagos, email/SMS, admin, mensajeria, reservas, disputas, identidad o features futuras salvo que el flujo completo exista en codigo.

## Roadmap

Orden estrategico:

1. Base tecnica.
2. Identidad y confianza.
3. Marketplace visible.
4. Interaccion entre usuarios.
5. Reservas y dinero.
6. Seguridad, moderacion y operacion.

No implementar funcionalidades de sprints futuros dentro de una tarea puntual salvo pedido explicito o preparacion minima justificada.

## Checklist Antes de Finalizar

- `npm run build`
- `npm test`
- `npm run check:prisma` si aplica
- `npm run check:env` si aplica
- `npm run test:endpoints:local` si afecta API y hay servidor local
- `npm run test:endpoints:render` o `npm run verify:render` si afecta deploy/remoto y existe `RENDER_API_URL`
- Actualizar `ENDPOINTS.md` si cambia el contrato HTTP
- Resumir archivos modificados, comandos ejecutados, resultados y pendientes
