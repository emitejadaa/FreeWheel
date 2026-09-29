# docverify-api · lectura de documentos argentinos

Extrae los datos del **DNI** y de la **licencia nacional de conducir**: encuadra
el documento, lo endereza, y lo lee por todos los medios que el documento
ofrezca — texto impreso por posición, PDF417, MRZ y códigos de barras lineales.

> **Este servicio no está conectado con el backend de FreeWheel.** No tiene base
> de datos, no guarda las imágenes, no sabe quién es el usuario y no le pega a
> ninguna otra API. Recibe una foto, la analiza y contesta. Se deploya aparte.

---

## Levantarlo

```bash
cd docverify-api
python -m venv .venv

# Windows (PowerShell o cmd)
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000

# Linux / Mac
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --reload --port 8000
```

No hace falta "activar" el entorno: se llama directo al Python del `.venv`, y
ese Python ya busca los paquetes al lado suyo. Activar es solo un atajo para no
escribir la ruta — un atajo que se rompe distinto en cada shell (`activate` vs
`Activate.ps1` vs `activate.bat`) y que, cuando falla en silencio, hace que
`pip install` vaya al Python del sistema y que después `uvicorn` no aparezca por
ningún lado. Con la ruta explícita eso no puede pasar.

Al arrancar, el servicio abre las tres sesiones de ONNX del motor de OCR en
segundo plano (los modelos vienen dentro del paquete `rapidocr`: no se baja
nada). Tarda unos segundos y no bloquea nada; `GET /health` dice en
`ocr_cargado` cuándo terminó.

Documentación interactiva: <http://localhost:8000/docs>

## Probarlo sin servidor

```bash
python probar_imagenes.py                 # las cuatro fotos de public/images/
python probar_imagenes.py dni-dorso       # una sola
python probar_imagenes.py --json          # el JSON completo

python depurar.py licencia-dorso --guardar   # renglones con coordenadas,
                                             # códigos, y el encuadre en .debug/
```

(Estos dos también van con el Python del entorno: `.venv/bin/python
probar_imagenes.py`, o `.venv\Scripts\python probar_imagenes.py` en Windows.)

`depurar.py` es la herramienta para **calibrar las zonas**: imprime qué leyó el
OCR y en qué coordenadas (0..1) del documento encuadrado, que es el sistema en
el que están escritas las zonas de cada extractor.

---

## Los endpoints

### El documento entero, en segundo plano

```
POST /analizar/documento
```

Es el que usa un backend. Recibe las **dos caras** juntas, contesta **202 en el
acto** y, cuando terminó, le pega de vuelta a la URL que le dejaron.

Es asíncrono por dos razones que empujan igual: un documento son dos análisis
de varios segundos cada uno, y **no pueden correr dos a la vez** —el motor de
OCR trabaja sobre imágenes descomprimidas y dos análisis simultáneos no entran
en una instancia de 512 MB—. Los pedidos se ponen en fila; `/health` dice
cuántos hay esperando.

Es además el único modo que puede **cruzar una cara contra la otra**, que es de
donde sale casi todo el valor: el apellido del frente del DNI contra el de la
MRZ del dorso, el número de licencia del frente contra el del PDF417 del dorso.

```bash
curl -X POST http://localhost:8000/analizar/documento \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $DOCVERIFY_TOKEN" \
  -d '{
    "documento": "dni",
    "frente_base64": "/9j/4AAQSk...",
    "dorso_base64": "/9j/4AAQSk...",
    "referencia": "id-de-la-fila-del-backend",
    "callback_url": "https://mi-backend/verification/identity/analysis-callback",
    "callback_token": "un-token-de-un-solo-uso"
  }'
```

Contesta `202 {"aceptado": true, "referencia": "...", "en_cola": 1}`, y al
terminar manda un `POST` al `callback_url` con
`{"referencia": ..., "resultado": {...}}` y el `callback_token` en el header
`Authorization`. Ese token es de quien pide el análisis, no nuestro: sirve para
que pueda comprobar que el aviso corresponde a un pedido suyo y no a cualquiera
que sepa la URL. Si el aviso no llega, se **reintenta** hasta cuatro veces con
espera creciente — esta API no guarda nada, así que un aviso perdido es un
análisis perdido.

**Sin `callback_url` analiza esperando** y devuelve el resultado en la misma
respuesta. Sirve para probar a mano; puede tardar más de lo que aguanta un
cliente HTTP común.

Si la fila está llena contesta **503** con `Retry-After`. No es un error: es que
ahora no puede.

### Una cara suelta, al toque

Para mirar una foto y ver qué se leyó. Uno por **cara**, porque cada cara se lee
distinto:

| Endpoint | Orígenes que devuelve |
|---|---|
| `POST /analizar/dni-frente` | `ocr` · `pdf417` |
| `POST /analizar/dni-dorso` | `ocr` · `mrz` · `qr`* |
| `POST /analizar/licencia-frente` | `ocr` · `qr`* |
| `POST /analizar/licencia-dorso` | `ocr` · `pdf417` · `codigo_1d` |

\* con `disponible: false`: ese documento no tiene ese código. No es un fallo.

Además: `GET /health` (estado y fila) y `GET /contrato` (qué campos devuelve
cada endpoint, sin tener que mandar una foto para averiguarlo).

### Cómo mandar la imagen

Las dos formas sirven en todos los endpoints:

```bash
# archivo (lo natural desde un <input type=file>)
curl -X POST -F "imagen=@dni_frente.jpg" \
  http://localhost:8000/analizar/dni-frente

# base64 (lo natural desde otro backend)
curl -X POST -H "content-type: application/json" \
  -d '{"imagen_base64":"/9j/4AAQSk..."}' \
  http://localhost:8000/analizar/dni-frente
```

El base64 acepta el data URI completo (`data:image/jpeg;base64,...`).

---

## La respuesta

Dos reglas, para que del otro lado no haya que ramificar:

1. **La forma no cambia nunca.** Los cuatro endpoints devuelven el mismo sobre,
   y dentro de un documento el juego de campos es siempre el mismo.
2. **Lo que no se detectó va vacío, no ausente.** Un campo ilegible es
   `{"valor": "", "crudo": "", "confianza": 0.0}`. La clave está siempre.

Siempre responde **200**, incluso cuando no pudo leer nada: que una foto salga
movida no es un error del pedido. El resultado va en `ok` y el motivo, por
origen, en su `error`.

```jsonc
{
  "ok": true,
  "documento": "dni_frente",
  "version": "2.0.0",
  "ms": 6028,

  "encuadre": {
    "detectado": true,
    "metodo": "umbral",        // contorno | umbral | minarea | ninguno
    "rotacion": 0,             // giro de 90° aplicado
    "angulo": 0.0,             // inclinación corregida
    "esquinas": [[0,0], [4027,0], [4027,1927], [302,2261]],
    "tamano_original": [4032, 2268],
    "tamano_encuadrado": [1600, 1009]
  },

  // qué es cada campo, para no tener que salir a buscarlo
  "diccionario": {
    "apellido": "Apellido del titular, como figura impreso",
    "numero_documento": "Número de DNI, sin puntos"
    // …
  },

  // ORGANIZADO POR ORIGEN: arriba el método de lectura, adentro sus campos
  "origenes": {
    "ocr": {
      "ok": true,
      "disponible": true,
      "error": "",
      "campos": {
        "apellido":         { "valor": "TEJADA ARAGON", "crudo": "TEJADA ARAGON", "confianza": 0.99 },
        "numero_documento": { "valor": "49380010",      "crudo": "49.380.010",    "confianza": 1.0 },
        "fecha_nacimiento": { "valor": "2009-04-06",    "crudo": "06 ABR/ APR 2009", "confianza": 1.0 }
        // …
      },
      "detalle": { "texto_completo": "…", "renglones": 28, "confianza_media": 0.95 }
      // (el dorso de la licencia NO manda texto_completo: ahí están impresos
      //  el grupo sanguíneo y las observaciones, que son datos de salud)
    },
    "pdf417": {
      "ok": true,
      "disponible": true,
      "campos": { "apellido": { "valor": "TEJADA ARAGON", "crudo": "TEJADA ARAGON", "confianza": 1.0 } },
      "detalle": { "crudo": "00708977612@TEJADA ARAGON@EMILIANO@M@…" }
    }
  },

  // para los campos que aparecen en MÁS DE UN origen: ¿dicen lo mismo?
  "coincidencias": {
    "apellido":         { "coinciden": true, "origenes": ["ocr", "pdf417"] },
    "numero_documento": { "coinciden": true, "origenes": ["ocr", "pdf417"] }
  }
}
```

`valor` está normalizado (fechas ISO, DNI sin puntos, CUIL con el verificador
validado) y sirve para comparar por máquina. `crudo` es lo que leyó el motor,
sin tocar, y sirve para auditar: cuando un valor sale mal es lo único que
permite saber si el problema fue la lectura o la normalización.

**`coincidencias` es el control importante.** En una tarjeta adulterada el
texto impreso y el código se contradicen, y esa comparación es lo único que lo
muestra.

En `/analizar/documento` las coincidencias van **a través de las dos caras**, y
cada lectura se identifica como `cara.origen` para que un desacuerdo diga quién
dijo qué:

```jsonc
"coincidencias": {
  "apellido": {
    "coinciden": true,
    "corroborado": true,          // más de un origen independiente lo confirmó
    "valores": ["TEJADA ARAGON"],
    "origenes": ["dorso.mrz", "frente.ocr", "frente.pdf417"],
    "por_origen": { "frente.ocr": "TEJADA ARAGON", "dorso.mrz": "TEJADA ARAGON" }
  }
}
```

---

## Qué campos devuelve, y por qué son pocos

De 28 campos quedaron 14. Los documentos traen impreso bastante más
—nacionalidad, ejemplar, número de trámite, oficina identificadora, domicilio,
lugar de nacimiento, código de control, jurisdicción, responsable— y todo eso se
leía bien. Se dejó de leer porque **un dato que no decide nada no es gratis**:
ocupa una zona de OCR, agrega un valor más que puede salir mal, y engorda un
JSON que alguien tiene que mirar. Cada campo que quedó está por una de dos
razones:

**SE CRUZA** — aparece en varias caras o varios orígenes, así que comparar las
lecturas entre sí detecta un documento adulterado: `apellido`, `nombre`,
`sexo`, `numero_documento`, `fecha_nacimiento`, `cuil`, `numero_licencia`.

**HABILITA** — el backend decide algo con él: `fecha_vencimiento`,
`fecha_otorgamiento`, `clase`, `es_principiante`, `fin_principiante`. Más
`tipo_documento` y `pais_emisor`, que tienen que decir `ID` y `ARG`.

Dos se sacaron por una razón más fuerte que la utilidad: **el grupo sanguíneo y
las observaciones de la licencia son datos de salud**, sensibles bajo la Ley
25.326. No hacían falta, y no tenerlos es la única forma segura de no
filtrarlos. Por eso el dorso de la licencia tampoco publica su `texto_completo`:
sería devolverlos por la ventana.

El **domicilio** se sacó por una razón distinta y práctica: el del documento
casi nunca coincide con el que la persona cargó —se mudó, lo abrevia distinto,
el OCR le come un número de altura—, así que cruzarlo produce rechazos falsos
sin detectar ningún fraude.

---

## Cómo lee cada documento

### DNI frente — OCR + PDF417
Los dos orígenes traen casi los mismos campos, y ahí está la gracia: se pueden
cruzar. El **vencimiento es la excepción**: no está codificado en el PDF417, así
que solo existe impreso y no se puede contrastar contra nada.

### DNI dorso — OCR + MRZ
División tajante. El **CUIL** existe únicamente impreso: no está ni en el PDF417
del frente ni en la MRZ. La **MRZ** (las tres líneas de `<<<` del pie) trae
apellido, nombre, sexo, documento, nacimiento y vencimiento **con sus dígitos
verificadores**: es la única lectura del documento que puede demostrar por sí
sola que se leyó bien.

### Licencia frente — solo OCR
No tiene ningún código. Sus datos solo se pueden contrastar contra el dorso.

### Licencia dorso — OCR + PDF417 + código 1D
El más rico. El dato que importa sacar bien es el **período de principiante**
("Principiante hasta 28/10/2026"), que determina si la persona puede manejar
sin acompañante y no está en ningún código: es OCR o nada. De todo el renglón de
"Observaciones" se extrae solo eso; la frase completa no sale de la función.

---

## Configuración

Todo opcional — sin `.env` el servicio levanta y funciona. Ver `.env.example`.

| Variable | Para qué |
|---|---|
| `DOCVERIFY_TOKEN` | Exige `Authorization: Bearer <token>`. Vacío = abierto. |
| `DOCVERIFY_ORIGENES` | Orígenes permitidos por CORS, separados por coma. |
| `DOCVERIFY_MAX_KB` | Tope de tamaño de imagen (default 15.000 KB). |
| `DOCVERIFY_CONCURRENCIA` | Análisis simultáneos (default 1). Subirlo requiere MÁS MEMORIA, no más CPU: dos análisis a la vez no entran en 512 MB. |
| `DOCVERIFY_COLA_MAXIMA` | Cuántos análisis se aceptan sin terminar antes de contestar 503 (default 8). |
| `DOCVERIFY_CALLBACK_TIMEOUT` | Segundos de espera al avisar que un análisis terminó (default 20). |

| `DOCVERIFY_LADO_MAXIMO` | Tope del lado más largo de la foto que entra (default 2400 px). |
| `DOCVERIFY_EXPUESTO` | Forzar el modo "publicado" (ver abajo). Normalmente no hace falta. |

**El token no es opcional cuando esto está publicado**: el servicio se niega a
arrancar sin él. Lo detecta solo, por las variables que ponen las plataformas
—`SPACE_ID` (Hugging Face), `RENDER_SERVICE_ID` (Render), `K_SERVICE` (Cloud
Run), `FLY_APP_NAME` (Fly)—, y `DOCVERIFY_EXPUESTO` está para forzarlo en
cualquier otra. En local, sin ninguna de esas, arranca abierto, que es lo cómodo
para probar.

Se mira eso y no una variable propia porque el olvido que hay que atrapar es
justamente el de una variable: una señal que pone la plataforma sola no se puede
olvidar.

Publicado cambian dos defaults, los dos hacia el lado seguro: el token pasa a
ser obligatorio y CORS queda cerrado.

---

## Deploy

Todo se instala con `pip` — no hace falta ningún binario del sistema (ni
Tesseract ni zbar), así que el deploy es igual en Windows y en Linux.

```bash
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

**No va en serverless.** Entre `opencv`, `numpy` y `onnxruntime` son ~300 MB de
wheels y el tope de una función de Vercel son 250 MB descomprimidos: no entra. Y
aunque entrara, cada arranque en frío volvería a cargar los modelos de OCR. Esto
necesita un proceso que viva entre pedidos.

**Y necesita memoria de verdad.** Está medido, no estimado: en una instancia de
512 MB un análisis de dos caras NO TERMINA. El proceso muere a los 2-3 minutos,
sin traceback y con `/health` contestando 200 hasta el final; una muestra llegó
a 510 MB contra el límite de 512. El pico está en la búsqueda de códigos de
barras, que trabaja sobre el encuadre canónico —1600×1009, un tamaño FIJO— y
saca copias al doble y al triple; por eso achicar la foto de entrada no lo baja.

Contar **2 GB o más**. Con eso, las opciones razonables:

| Dónde | RAM | CPU | Costo |
|---|---|---|---|
| **Hugging Face Spaces** | 16 GB | 2 vCPU | gratis |
| Google Cloud Run | 1-2 GB | 1-2 | gratis hasta 180.000 vCPU-s/mes |
| Oracle Cloud Always Free | 24 GB | 4 (ARM) | gratis, pero es una VM que administrás vos |
| Render **Standard** | 2 GB | 1 | US$ 25/mes |

Render `free` y `starter` quedan afuera: los dos tienen 512 MB y entre ellos
solo cambia la CPU, así que pagar los US$ 7 de `starter` compraría velocidad
para un análisis que igual no termina.

---

### En tu máquina, junto con el backend

Es lo que está andando hoy, y no es un modo degradado: el análisis tarda **~10
segundos las dos caras** en una máquina común, contra los 2-3 minutos (y el
proceso muerto) de una instancia chica.

**1 · Levantar la API.**

```bash
cd docverify-api
python -m venv .venv

# Windows (PowerShell o cmd)
.venv\Scripts\python -m pip install -r requirements.txt   # ~300 MB, una sola vez
.venv\Scripts\python -m uvicorn app.main:app --port 8000

# Linux / Mac
.venv/bin/python -m pip install -r requirements.txt        # ~300 MB, una sola vez
.venv/bin/python -m uvicorn app.main:app --port 8000
```

Se llama al Python del `.venv` por su ruta, sin activar nada: es la forma que
funciona igual en PowerShell, en cmd y en bash.

`http://127.0.0.1:8000/health` tiene que contestar. En local **no pide token**:
el servicio solo lo exige cuando detecta que está publicado.

**2 · Apuntar el backend.** En el `.env` del backend:

```bash
DOCVERIFY_URL="http://127.0.0.1:8000"
```

Y nada más. `DOCVERIFY_TOKEN` se deja vacío —la API local no lo pide— y
`PUBLIC_URL` tampoco hace falta: fuera de producción el backend deduce su propia
URL como `http://localhost:<PORT>`, que es lo que necesita para recibir el aviso
cuando el análisis termina.

**3 · Levantar el backend** (`npm run start:dev`) y listo. Subís un documento y
a los ~10 segundos el estado cambia solo.

#### Si el backend dice `fetch failed`

Ese mensaje es de Node y significa "no llegué", sin decir por qué: el motivo
real viaja escondido y las causas son varias, cada una con su arreglo. Para no
adivinar:

```bash
npm run check:docverify   # desde la raíz del backend
```

Prueba la URL, la conexión, el token y la vuelta del resultado, y dice cuál de
las cuatro falló. Las causas habituales, en orden de frecuencia:

| Lo que pasa | Cómo se arregla |
| --- | --- |
| `DOCVERIFY_URL` sin `http://` | Escribirla entera: `http://127.0.0.1:8000` |
| La API no está levantada, o está en otro puerto | Levantarla, o corregir el puerto |
| El backend está desplegado y la URL es `127.0.0.1` | Un deploy no llega a tu máquina: ver las alternativas de más arriba |
| `DOCVERIFY_TOKEN` distinto de los dos lados | Que sea el mismo, o vaciarlo en local |

Desde la versión con diagnóstico, el backend ya no registra `fetch failed` a
secas: el log y `analysis.error` traen el motivo concreto (`ECONNREFUSED`,
`ENOTFOUND`, ...) y qué revisar.

#### Si dice `uvicorn: no se encontró` / `command not found`

Es siempre lo mismo: se está ejecutando el `uvicorn` del PATH, que no existe,
en vez del que está adentro del `.venv`. La solución es no depender del PATH —
`.venv/bin/python -m uvicorn ...` (o `.venv\Scripts\python -m uvicorn ...` en
Windows), como está arriba.

Para confirmar que el entorno quedó bien:

```bash
.venv/bin/python -m uvicorn --version        # Windows: .venv\Scripts\python -m ...
# Running uvicorn 0.40.0 with CPython 3.11.x
```

Si eso también falla, entonces el `pip install` no llegó a este entorno:
repetilo con el mismo Python (`.venv/bin/python -m pip install -r
requirements.txt`) y volvé a probar.

#### Por qué la misma dirección siempre

Usá **`127.0.0.1`**, no la IP de tu red. `127.0.0.1` es la misma en todas las
máquinas, en todas las redes y para siempre: no depende del router, no cambia al
reconectarte al wifi ni al pasar de casa a otro lado. La IP de tu red (`192.168.
x.y`) la asigna el router y puede cambiar sola.

Eso alcanza **si la API y el backend corren en la misma máquina**, que es el
caso normal. Si de verdad necesitás llamarla desde OTRA máquina de la misma red:

1. Levantá la API con `--host 0.0.0.0` (si no, solo escucha en loopback).
2. Fijá la IP en el ROUTER, no en la máquina: casi todos tienen "DHCP
   reservation" o "IP estática por MAC". Atarla ahí sobrevive a reinstalar el
   sistema y no se pelea con el DHCP, que es lo que pasa cuando se configura del
   lado de la máquina.
3. Poné el token: en una red compartida, una API sin token que acepta documentos
   de identidad la puede usar cualquiera que esté conectado. Con
   `DOCVERIFY_TOKEN` en las dos puntas alcanza.

#### Lo que NO funciona: backend en Vercel + API en tu máquina

Y conviene tenerlo claro antes de intentarlo. `127.0.0.1` y `192.168.x.y` son
direcciones **privadas**: no existen fuera de tu red. Un servidor de Vercel que
intente conectarse ahí se está apuntando a sí mismo, no a tu computadora. No es
cuestión de configurarlo bien; no hay ruta.

Las salidas reales son tres:

- **Backend local también.** Lo de arriba. Para desarrollar y mostrar, es lo más
  simple y lo más rápido.
- **Un túnel.** Le da a tu API local una URL pública. Es gratis, no pide tarjeta
  y es lo que sirve para probar el deploy de Vercel contra tu máquina. La receta
  completa está abajo.
- **Dar vuelta el flujo.** Que la API, desde tu máquina, le PREGUNTE al backend
  si hay documentos para analizar, en vez de esperar a que la llamen. Tu máquina
  sí puede salir a internet; lo que no puede es recibir. Es como funciona un
  runner de CI, y es la solución de fondo para "no tengo dónde hostear esto",
  pero es trabajo: hace falta una cola, tomar y devolver trabajos, y un token de
  worker.

#### Receta: exponer la API local con un túnel

Para el caso concreto de "el backend está en Vercel y la API corre en mi
máquina". Gratis y sin cuenta.

**1 · Un secreto compartido.** Cualquier cosa larga y al azar:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**2 · Levantar la API pidiendo token.** `DOCVERIFY_EXPUESTO=1` es
imprescindible y es el paso que más se olvida: detrás de un túnel la API sigue
corriendo en tu máquina, así que no ve ninguna señal de plataforma, se cree en
local y arranca **sin token y con CORS abierto**. La URL, mientras tanto, la
alcanza cualquiera. Esa variable la obliga a exigir token (y a negarse a
arrancar sin uno, que es justo lo que querés que pase).

```bash
# Linux / Mac
DOCVERIFY_EXPUESTO=1 DOCVERIFY_TOKEN="<el secreto del paso 1>" \
  .venv/bin/python -m uvicorn app.main:app --port 8000

# Windows (PowerShell)
$env:DOCVERIFY_EXPUESTO=1; $env:DOCVERIFY_TOKEN="<el secreto>"
.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

**3 · Abrir el túnel**, en otra terminal. `cloudflared` no pide cuenta ni
tarjeta:

```bash
# Mac: brew install cloudflared · Windows: winget install Cloudflare.cloudflared
# Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://127.0.0.1:8000
```

Imprime una URL tipo `https://algo-al-azar.trycloudflare.com`. Esa es la
pública. (`ngrok http 8000` hace lo mismo pero pide cuenta gratuita.)

**4 · Configurar Vercel.** En el proyecto del BACKEND → Settings → Environment
Variables:

| Variable | Valor |
| --- | --- |
| `DOCVERIFY_URL` | `https://algo-al-azar.trycloudflare.com` (sin barra final) |
| `DOCVERIFY_TOKEN` | el secreto del paso 1, idéntico |

`DOCVERIFY_PLATFORM_TOKEN` se deja vacío: es solo para un Space privado de
Hugging Face. **Redeployá** después de tocar las variables — Vercel no las
aplica a un deploy ya hecho.

**5 · Destrabar el aviso de vuelta.** El paso que más cuesta encontrar, porque
todo lo demás funciona: el documento se lee perfecto y el resultado se pierde.

La **Deployment Protection** de Vercel viene activada y protege con su propio
login la URL única de cada deploy (`proyecto-a1b2c3-org.vercel.app`), que es la
que trae `VERCEL_URL`. La API de lectura no tiene cómo pasar ese login, así que
su aviso recibe `401 Protected deployment` antes de llegar al backend. En el log
de la API se ve así:

```txt
POST .../verification/identity/analysis-callback "HTTP/1.1 401 Unauthorized"
el backend rechazó el aviso de <ref> con 401: {"protection":{"vercel_auth_enabled":true
```

Cualquiera de las dos salidas sirve:

- **Apuntar al dominio de producción**, que es público: el backend ya prefiere
  `VERCEL_PROJECT_PRODUCTION_URL` sobre `VERCEL_URL`, así que en un deploy de
  producción esto se arregla solo. Para forzarlo, `PUBLIC_URL` con el dominio
  del proyecto (no la URL del deploy).
- **Desactivar la protección**: Settings → Deployment Protection → Vercel
  Authentication.

**6 · Comprobar.** Desde la raíz del backend, con esas mismas variables:

```bash
npm run check:docverify
```

**Lo que hay que saber antes de apoyarse en esto:** la URL vive mientras el
túnel esté abierto. Si lo cerrás, reiniciás la máquina o se corta internet,
cambia —y hay que actualizar `DOCVERIFY_URL` en Vercel y redeployar—. Sirve para
desarrollar y para mostrar; para algo que tiene que estar siempre, es la opción
equivocada.

---

### Seguridad

Por acá pasan documentos de identidad de personas reales, en una plataforma
pensada para demos públicas. Lo que hay puesto:

- **El token es obligatorio cuando el servicio está publicado.** No es una
  recomendación: el proceso **no arranca** sin él si detecta que corre en un
  Space o en Render. La comparación es de tiempo constante, para que no se pueda
  adivinar el token midiendo cuánto tarda el 401.
- **Dos headers para el token.** `X-Docverify-Token` o `Authorization: Bearer`.
  Existen los dos porque en un Space **privado** el `Authorization` ya lo ocupa
  el token de Hugging Face; así las dos protecciones conviven —la de la
  plataforma decide quién llega al contenedor, la nuestra quién puede analizar.
- **CORS cerrado al publicar.** En local queda abierto para poder usar el HTML
  de prueba; publicado, ningún navegador puede llamarlo. El backend lo llama
  desde el servidor, donde CORS no interviene, así que cerrarlo no le saca nada
  a nadie y deja afuera la página que un tercero arme para que el navegador de
  una víctima le mande sus documentos.
- **El proceso no corre como root.** Abre imágenes ajenas con OpenCV, libjpeg y
  un decodificador de códigos de barras: tres montones de C parseando archivos
  que manda gente de afuera.
- **No se guarda nada.** Ni las imágenes, ni lo leído, ni quién llamó. No hay
  base de datos ni disco: cuando el request termina, no queda rastro.
- **Los logs no llevan contenido de los documentos.** Solo el tipo de documento,
  la referencia opaca que mandó el backend y los tiempos.

Con el Space **público**, quien conozca la URL puede ver que existe pero recibe
401 en todo. Con el Space **privado** ni siquiera llega al contenedor. Si podés,
privado.

---

## Qué esperar de la extracción

Medido contra las cuatro fotos de `public/images/` (fotos de teléfono reales,
con reflejos, una de ellas sacada de costado):

Esa medición se hizo con el contrato viejo, de 28 campos; los números son de
entonces y se dejan porque lo que muestran sigue valiendo — qué lee bien cada
origen y qué no:

| Documento | Resultado |
|---|---|
| DNI frente | 11/11 campos por OCR · 8/8 por PDF417 · los 8 cruces coinciden |
| DNI dorso | 5/5 por OCR · 9/9 por MRZ, con los 4 verificadores cerrando |
| Licencia frente | 9/9 campos |
| Licencia dorso | 8/9 por OCR · código 1D leído · **PDF417 no decodifica** |

Dos cosas honestas sobre esa tabla:

- **El PDF417 del dorso de la licencia no se pudo leer en esa foto.** No es un
  problema del código: está sobreexpuesto y los módulos del barcode se fundieron
  entre sí. Se probaron recortes, escalas, rotaciones, cuatro binarizadores y
  varios preprocesados morfológicos, y ninguno decodifica. Con una foto mejor
  del mismo documento debería salir; la API lo reporta con `ok: false` y el
  motivo, que es exactamente para lo que está ese campo.
- **`grupo_sanguineo` salía vacío en la licencia y estaba bien:** el documento
  tiene un guion ahí. Hoy ese campo ya no se lee (ver "Qué campos devuelve").

El tiempo por análisis ronda los **3 a 6 segundos** en una máquina de
escritorio, y bastante más en el medio CPU de una instancia chica. Un documento
son dos análisis, y no corren en paralelo: por eso `/analizar/documento` es
asíncrono.
