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
.venv/Scripts/activate          # Linux/Mac: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

La primera llamada tarda unos segundos más: el motor de OCR carga tres modelos
ONNX (~100 MB, se bajan una sola vez y quedan cacheados). `GET /health` dice si
ya están cargados.

Documentación interactiva: <http://localhost:8000/docs>

## Probarlo sin servidor

```bash
python probar_imagenes.py                 # las cuatro fotos de public/images/
python probar_imagenes.py dni-dorso       # una sola
python probar_imagenes.py --json          # el JSON completo

python depurar.py licencia-dorso --guardar   # renglones con coordenadas,
                                             # códigos, y el encuadre en .debug/
```

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

En un deploy expuesto a internet **poné el token**: por acá pasan documentos de
identidad de personas reales, y sin token alcanza con conocer la URL.

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

### En Render, paso a paso

La raíz del repo tiene un `render.yaml` que ya describe este servicio. Toma
entre 8 y 15 minutos, casi todo esperando el primer build: la imagen pesa ~1 GB
y precarga los modelos. Los builds siguientes reusan las capas de `pip` y bajan
a 2-3 minutos.

**1 · Crear el servicio.** En el dashboard de Render → **New** → **Blueprint** →
repo `emitejadaa/FreeWheel`, rama `main`. Render lee el `render.yaml` y muestra
un servicio `freewheel-docverify`. **Apply**.

> A mano (New → Web Service) los valores son: Language **Docker**, Dockerfile
> Path `./docverify-api/Dockerfile`, Docker Build Context Directory
> `./docverify-api`, Health Check Path `/health`.

**2 · El plan.** El blueprint arranca en **Free**, y el sistema está hecho para
que alcance. Lo que se paga son dos cosas:

- **Se apaga a los 15 minutos sin tráfico**, y despertar esta imagen tarda ~50
  segundos. Eso es más de lo que el backend puede esperar, así que el primer
  análisis después de un rato **siempre se cae**. No es un problema: ese pedido
  es el que lo despierta, el documento queda igual de válido, y el front
  reintenta con `POST /verification/identity/:document/retry-analysis`, que ya
  lo encuentra andando. Si nadie reintenta, lo revisa un admin.
- **0,1 CPU** contra los 0,5 de Starter: el análisis tarda varias veces más.
  Tampoco bloquea a nadie, porque es asíncrono; el usuario solo ve "revisando
  tus documentos" más tiempo.

La **memoria es la misma** en los dos planes (512 MB), y es el recurso que de
verdad podría no alcanzar: el OCR sobre ONNX ronda los 400-500 MB residentes.
O sea que si anda en Free, el problema de Starter era solo la velocidad.

Para pasar a **Starter** (US$ 7/mes) cambiá `plan:` en `render.yaml` o el plan
desde el dashboard. Conviene cuando la espera empiece a molestar, no antes. Si
el servicio se reinicia con *out of memory*, el salto que hace falta es a
**Standard** (2 GB), que es otro problema y otra solución.

### Otras opciones gratuitas

Render Free es la de menos trabajo porque el `render.yaml` ya está escrito. Si
la velocidad no alcanza, estas dan bastante más sin costo:

| Dónde | RAM | CPU | Se duerme | Qué hay que tocar |
|---|---|---|---|---|
| **Render Free** | 512 MB | 0,1 | 15 min | nada |
| **Hugging Face Spaces** | 16 GB | 2 vCPU | 48 h | escuchar en el puerto 7860 y agregar el header YAML del Space |
| **Google Cloud Run** | 1-2 GB | 1-2 | escala a cero | cuenta de GCP con tarjeta; 180.000 vCPU-segundos por mes gratis |
| **Oracle Cloud Always Free** | 24 GB | 4 (ARM) | no | es una VM: la administrás vos. Las wheels de numpy, opencv y onnxruntime tienen build para aarch64, así que corre |

Dos advertencias honestas:

- **Hugging Face Spaces** es la que más potencia da gratis y está pensada
  justamente para servir modelos, pero es una plataforma de demos: los Spaces
  son públicos por defecto. Por acá pasan documentos de identidad de personas
  reales, así que ahí `DOCVERIFY_TOKEN` deja de ser recomendable y pasa a ser
  obligatorio. Este servicio no guarda ninguna imagen, que es lo que hace la
  idea defendible.
- **Cloud Run** es la más parecida a producción de las gratuitas, pero el
  arranque en frío de una imagen de 1 GB también se pasa de lo que el backend
  espera: el reintento sigue haciendo falta igual.

**3 · El token.** Render genera `DOCVERIFY_TOKEN` solo. Copialo de la pestaña
**Environment**: es el que hay que poner en el backend. Sin él la API responde
401.

**4 · Comprobar.** Cuando quede en **Live**:

```bash
curl https://<tu-servicio>.onrender.com/health
```

Los dos campos que importan son `protegido_con_token: true` (el token quedó
puesto) y `ocr_cargado: true` (los modelos se precargaron en el build, así que
no los baja el primer usuario).

**5 · Conectarlo al backend.** En las variables de entorno del backend:
`DOCVERIFY_URL` con la URL de Render (sin barra final) y `DOCVERIFY_TOKEN` con
el token del paso 3.

No hace falta base de datos ni disco persistente: esta API no guarda nada, y los
modelos ya están dentro de la imagen.

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
