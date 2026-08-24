# Qué cargar en el Vercel del backend

Lista completa de las variables de entorno que lee este backend, con qué valor va
en cada una y qué deja de funcionar si falta. Es lo único que hay que tocar en el
panel de Vercel (**Project → Settings → Environment Variables**), y después
**Redeploy**: Vercel no toma las variables nuevas hasta que se vuelve a publicar.

Cada variable se carga para los tres entornos (Production, Preview, Development)
salvo que se aclare lo contrario.

> **Para saber qué falta sin pedir una captura del panel:** abrir
> `https://free-wheel-back.vercel.app/health/env`. Dice qué variables están
> cargadas, qué falta y qué se pierde por cada cosa que falta. Devuelve solo
> nombres y true/false — nunca el valor de una variable.

---

## 1. Obligatorias — sin esto la API no arranca

| Variable | Valor | Si falta |
|---|---|---|
| `DATABASE_URL` | La cadena de conexión de Postgres: `postgresql://usuario:clave@host:5432/base?sslmode=require` | La API contesta error 500 en todo. |
| `JWT_SECRET` | Un texto largo e inventado, cualquiera, sin espacios (por ejemplo 40 caracteres al azar). No hay que "sacarlo" de ningún lado: se elige y se deja. | Nadie puede iniciar sesión. |

Estas dos **ya están cargadas** (la app entra y muestra los autos, así que la base
y el login funcionan). No hace falta tocarlas.

> `DIRECT_URL` es opcional. Solo sirve si el proveedor de la base usa un *pooler*
> que no admite migraciones (Supabase en el puerto 6543, o Neon). Si no está, se
> completa sola con `DATABASE_URL`.

---

## 2. La revisión de fotos con IA

| Variable | Valor | Si falta |
|---|---|---|
| `GROQ_API_KEY` | La clave de una cuenta de Groq. Empieza con `gsk_`. | La verificación de identidad **sigue funcionando**: se apoya en el código PDF417 del DNI cruzado contra los datos del formulario. Lo que se pierde es la lectura del texto impreso (domicilio, vencimientos), el chatbot y la revisión de las fotos de los autos. |
| `GROQ_VISION_MODEL` | *Opcional.* El nombre exacto de un modelo que mire imágenes. Se pueden poner varios separados por coma y se usan en ese orden. | Se usan los del código, con `qwen/qwen3.6-27b` primero. |
| `CORS_STRICT` | *Opcional.* Con `"true"` vuelve la lista blanca de orígenes. | **La API contesta a cualquier origen** (así está hoy, a propósito, para poder probar sin trabas). |
| `DEMO_ORIGINS` | *Opcional.* Orígenes extra, solo cuando `CORS_STRICT="true"`. | Nada: sin `CORS_STRICT` ya está todo permitido. |

### Probar la verificación de documentos

La verificación documental corre el subproyecto Python `python-verifier/` como
subproceso. **En Vercel serverless no hay Python**, así que ahí `DOCVERIFY_MODE`
degrada solo a `manual`: los documentos se guardan y quedan esperando a un
admin (`GET /admin/verifications?status=MANUAL_REVIEW`), sin aprobar nada solo.

Para probar la verificación automática de punta a punta hace falta correr el
backend donde sí haya Python y el binario `tesseract` con español:

```bash
cd python-verifier
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# Arch:          sudo pacman -S tesseract tesseract-data-spa tesseract-data-eng
# Ubuntu/Debian: sudo apt install tesseract-ocr tesseract-ocr-spa
cd .. && npm run start:dev     # con DOCVERIFY_MODE=auto
```

Y probar el verificador solo, sin backend:

```bash
cd python-verifier
echo '{"documentos": {"dni_front": "ruta/a/foto.jpg"}}' | .venv/bin/python analyze.py
```

Los endpoints del flujo están en `src/verification/verification.rest`.

### Estado al 9 de agosto de 2026

`GROQ_API_KEY` **ya está cargada y funciona**, y `qwen/qwen3.6-27b` **existe en
esa cuenta**. Se ve en el panel de administración: si la clave no sirviera, Groq
contestaría 401 y no se podría ni pedir la lista de modelos.

Los dos modelos `meta-llama/llama-4-*` contestan 404: Groq **los dio de baja en
junio de 2026** y mandó a migrar a qwen. Por eso ahora qwen va primero en el
código y los llama-4 quedan solo de respaldo. **No hace falta cargar
`GROQ_VISION_MODEL`.**

### Cómo crear la clave, si alguna vez hay que hacerlo de nuevo

1. Entrar a **console.groq.com** y crear la cuenta (se puede con Google).
2. Ir a **API Keys → Create API Key**, ponerle cualquier nombre.
3. **Copiar la clave en ese momento**: después no se puede volver a ver, solo
   crear otra.
4. Cargarla en Vercel como `GROQ_API_KEY` y hacer **Redeploy**.

### Cómo leer "Probar los modelos" del panel

**Panel admin → Verificaciones → Modelos de la revisión por IA → Probar los
modelos**. Le manda una imagen de prueba a cada modelo y muestra tres resultados
posibles:

- **ANDA** → ese nombre sirve. Si el primero dice ANDA, no hay nada que cargar.
- **SIN PROBAR** → el modelo existe y la clave sirve, pero rechazó la imagen de
  prueba (por ejemplo `400 invalid image data`). **No quiere decir que esté
  roto**: el pedido llegó, se autenticó y el modelo lo entendió. Para saberlo de
  verdad hay que subir un DNI en la verificación de identidad y ver si lo revisa.
- **FALLA 401** → la clave no sirve (mal copiada, o de otra cuenta).
- **FALLA 429** → la clave funciona pero se agotó la cuota del día.
- **FALLA 404** → ese modelo ya no existe en Groq. La pantalla lista abajo los
  que ofrece hoy; copiar uno de esos en `GROQ_VISION_MODEL` y redeploy.

Ese botón es la única forma confiable de saberlo, porque Groq cambia los modelos
que ofrece cada pocos meses y cualquier lista escrita hoy queda vieja.

### Mientras la clave no esté

La app no se rompe: la verificación de identidad queda **pendiente de revisión
manual** y se aprueba desde el panel de administración
(`PATCH /admin/verifications/:id/review`). Si se prefiere que apruebe sola
cualquier envío con las cuatro fotos, se puede poner
`DOCVERIFY_MODE=auto_approve`, pero entonces no se revisa nada —incluida la
foto de un perro como DNI—, así que conviene dejarlo en `ai`.

---

## 3. Los emails (códigos de verificación y recuperar la contraseña)

| Variable | Valor | Si falta |
|---|---|---|
| `GMAIL_USER` | La dirección de Gmail desde la que salen los mails. | No se manda ningún mail: no se puede terminar de registrarse ni recuperar la contraseña. |
| `GMAIL_APP_PASSWORD` | Una **contraseña de aplicación** de esa cuenta, de 16 letras. **No** es la contraseña de la cuenta. | Igual que arriba. |

Se saca en la cuenta de Google → **Seguridad → Verificación en dos pasos**
(hay que tenerla activada) → **Contraseñas de aplicaciones** → crear una y copiar
las 16 letras.

Esto **ya tiene que estar cargado**, porque el registro pide un código por mail y
funciona.

---

## 4. Las fotos que suben los usuarios (Cloudinary)

| Variable | Valor | Si falta |
|---|---|---|
| `CLOUDINARY_CLOUD_NAME` | El nombre de la cuenta de Cloudinary (aparece en el panel como *Cloud name*). | Se sigue pudiendo subir fotos, pero por un camino sin firmar: el navegador usa un *preset* abierto y cualquiera que lea el código de la página podría subir archivos a esa cuenta. |
| `CLOUDINARY_API_KEY` | *API Key* del panel de Cloudinary. | Igual que arriba. |
| `CLOUDINARY_API_SECRET` | *API Secret* del mismo panel. **No se comparte ni se pone en el front.** | Igual que arriba. |

Con las tres cargadas, el backend firma cada subida y el secreto no sale nunca del
servidor. Es la parte que más conviene completar después de Groq.

---

## 5. Los links que van dentro de los mails

| Variable | Valor | Si falta |
|---|---|---|
| `FRONTEND_URL` | `https://freewheel-5a.vercel.app` | Los links de los mails (verificar el email, recuperar la contraseña, volver del pago) apuntan a `localhost`, así que no funcionan para nadie. |
| `API_BASE_URL` | `https://free-wheel-back.vercel.app` | Se completa con la URL que Vercel arma sola (`VERCEL_URL`), que cambia en cada deploy; por eso conviene fijarla. |

---

## 6. Los pagos (Stripe) — solo modo de prueba

Este backend **se niega a arrancar con una clave real de Stripe**: solo acepta
claves de prueba (`sk_test_` / `rk_test_`). No puede cobrar dinero de verdad.

| Variable | Valor | Si falta |
|---|---|---|
| `PAYMENTS_PROVIDER` | `mock` para no usar Stripe (los pagos se simulan y las reservas avanzan igual) o `stripe` para usar las claves de prueba. | Vale `mock`. |
| `STRIPE_SECRET_KEY` | La clave secreta **de prueba** del panel de Stripe. Solo si `PAYMENTS_PROVIDER=stripe`. | Con `mock` no hace falta. |
| `STRIPE_PUBLISHABLE_KEY` | La clave pública de prueba (`pk_test_...`). | Ídem. |
| `STRIPE_WEBHOOK_SECRET` | El secreto del webhook (`whsec_...`), de **Developers → Webhooks** apuntando a `https://free-wheel-back.vercel.app/payments/stripe/webhook`. | Stripe avisa que pagó y el backend rechaza el aviso por firma inválida: la reserva queda sin marcar como pagada. |

Para una entrega de la facultad, `PAYMENTS_PROVIDER=mock` alcanza y evita tener
que crear una cuenta de Stripe.

---

## 7. El resto: tiene valor por defecto y anda sin tocarlo

| Variable | Por defecto | Para qué |
|---|---|---|
| `JWT_EXPIRES_IN` | `24h` | Cuánto dura la sesión. |
| `ONBOARDING_JWT_EXPIRES_IN` | `30m` | Cuánto dura el token del registro a medio hacer. |
| `DOCVERIFY_MODE` | `auto` | Cómo se revisan el DNI y la licencia: `auto` (verificador Python), `manual` o `auto_approve`. En Vercel serverless **no hay Python**, así que `auto` degrada a `manual` avisando. |
| `DOCVERIFY_TIMEOUT_MS` | `120000` | Tope del verificador. Solo aplica donde `auto` esté realmente disponible. |
| `SMS_PROVIDER` | `mock` | Por dónde sale el código del teléfono. Con `mock` llega al **email** de la persona y la verificación funciona igual, sin costo. Con `twilio`, sale por SMS de verdad y hacen falta las tres de abajo. |
| `TWILIO_ACCOUNT_SID` | — | Solo con `SMS_PROVIDER=twilio`. Está arriba de todo en la consola de Twilio (empieza con `AC`). |
| `TWILIO_AUTH_TOKEN` | — | Solo con `SMS_PROVIDER=twilio`. Al lado del anterior. |
| `TWILIO_FROM_NUMBER` | — | Solo con `SMS_PROVIDER=twilio`. El número que te dio Twilio (`+1...`). Se puede reemplazar por `TWILIO_MESSAGING_SERVICE_SID` (`MG...`); va uno de los dos. |
| `REQUIRE_PHONE_VERIFICATION` | `false` | Si el teléfono confirmado es obligatorio para publicar y reservar. |
| `VERIFICATION_CODE_IN_RESPONSE` | `false` | Solo para mostrar la app: con `true`, la pantalla muestra el código en vez de hacer esperar el mail. |
| `PRICE_CHANGE_COOLDOWN_HOURS` | `24` | Cada cuánto se puede cambiar el precio de una publicación. |
| `ALLOW_ACCOUNT_HARD_DELETE` | vacío | Si un admin puede **borrar** cuentas de verdad (`DELETE /admin/users/:id`) en vez de solo suspenderlas. Vacío = habilitado en todos lados **menos en producción**, así que en Vercel ya está apagado sin tocar nada. Ver abajo. |
| `PLATFORM_FEE_PCT` | `0.10` | Comisión de la plataforma (fracción, no porcentaje). |
| `INSURANCE_PCT` | `0.10` | Seguro. |
| `SENA_PCT` | `0.30` | Qué parte se paga como seña. |
| `DEPOSIT_DEFAULT_USD` | `200` | Depósito en garantía. |
| `DEFAULT_CURRENCY` | `usd` | Moneda de los cobros. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | vacío | Entrar con Google. Sin esto, ese botón no funciona; el registro normal sí. |
| `PORT` | `3000` | Solo para correrlo localmente. En Vercel no se usa. |

`CORS` no necesita ninguna variable: la API acepta cualquier origen a propósito,
para que funcionen tanto el dominio principal como las vistas previas de Vercel.

### Por qué en producción no se borran cuentas

En el deploy, `DELETE /admin/users/:id` contesta `403` y no borra nada. No es un
error: es a propósito.

Borrar una cuenta libera sus datos únicos —el email, el teléfono, el DNI—. Si se
borrara la cuenta de alguien a quien se expulsó por estafar, esa misma persona
podría registrarse de nuevo al día siguiente con el mismo documento. Y de paso se
llevaría puestas las reservas, los pagos y las reseñas de las otras personas que
alquilaron con ella.

Para sacar a alguien de circulación está **`PATCH /admin/users/:id/status`** con
`SUSPENDED` (baneada) o `DELETED` (dada de baja): no puede iniciar sesión ni por
email ni por Google, los tokens que ya tenía dejan de valer en el acto, y sus
datos siguen tomados para que nadie los reutilice.

El borrado existe para el desarrollo, donde hace falta rearmar las cuentas de
demostración con los mismos correos. Si alguna vez se quiere un entorno de
demostración con borrado habilitado corriendo en Vercel, se pone
`ALLOW_ACCOUNT_HARD_DELETE="true"`.

---

## 8. La base de datos se actualiza sola

No hay que correr ninguna migración a mano. El `postinstall` del proyecto ejecuta
`scripts/deploy-migrate.js` en cada deploy, que:

1. mira si la base tiene historial de migraciones;
2. si lo tiene, corre `prisma migrate deploy`;
3. si no (la base se creó con `db push`), corre `prisma db push`, **sin**
   `--accept-data-loss`: si un cambio implicara borrar datos, Prisma se niega y no
   toca nada;
4. completa la categoría de los autos publicados antes de que esa columna
   existiera.

Si algo de eso falla, **el deploy no se cae**: la API se publica igual con un
aviso en el log, y `GET /health/db` dice exactamente qué columna falta.

---

## 9. Orden recomendado

1. **`GROQ_API_KEY`** → arregla la revisión de fotos, que es lo único que hoy está
   roto de verdad.
2. Probar los modelos desde el panel de administración y, solo si hace falta,
   cargar `GROQ_VISION_MODEL`.
3. **`CLOUDINARY_*`** → que las fotos suban firmadas.
4. **`FRONTEND_URL`** y **`API_BASE_URL`** → que los links de los mails apunten al
   lugar correcto.
5. El resto puede quedarse como está.

Después de cada cambio: **Redeploy**. Y para confirmar que quedó bien, abrir
`https://free-wheel-back.vercel.app/ai/health` (dice si la clave de Groq está
cargada) y `https://free-wheel-back.vercel.app/health/db` (dice si la base está al
día).
