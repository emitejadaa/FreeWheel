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
(`SPACE_ID` en Hugging Face, `RENDER_SERVICE_ID` en Render); `DOCVERIFY_EXPUESTO`
está para forzarlo en cualquier otra. En local, sin ninguna de esas, arranca
abierto — que es lo cómodo para probar.

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

### En Hugging Face Spaces, paso a paso

Es la opción elegida: 16 GB y 2 vCPU gratis, y la plataforma está hecha
justamente para servir modelos.

**1 · Crear el Space.** En <https://huggingface.co/new-space>:

| Campo | Valor |
|---|---|
| Space name | `freewheel-docverify` |
| License | la que prefieras |
| SDK | **Docker** → *Blank* |
| Hardware | **CPU basic** (2 vCPU, 16 GB — gratis) |
| Visibility | **Private** (recomendado) o Public |

**2 · Cargar el secreto.** En el Space → **Settings** → **Variables and
secrets** → *New secret*:

| Nombre | Valor |
|---|---|
| `DOCVERIFY_TOKEN` | una cadena larga y al azar (`openssl rand -base64 32`) |

Va como **secret**, no como variable: las variables se ven en la página del
Space. Y no es opcional — **el servicio se niega a arrancar sin él cuando
detecta que está publicado**, justamente para que "lo deployé y me olvidé el
token" no pueda pasar desapercibido.

Opcional, para aprovechar los 2 núcleos:

| Nombre | Valor |
|---|---|
| `DOCVERIFY_CONCURRENCIA` | `2` |

> **No intentes fijar `OMP_NUM_THREADS` ni las otras `*_NUM_THREADS` acá.**
> Hugging Face las tiene RESERVADAS: si las cargás, el Space ni siquiera
> construye — queda en `CONFIG_ERROR` con el mensaje *"Reserved environment
> variables"*, que aparece antes del build y por eso no deja ningún log donde
> buscarlo.
>
> Tampoco hacen falta. Limitar los hilos servía en una instancia con 0,15 de un
> núcleo, donde repartir ese pedacito solo agregaba trabajo; con 2 vCPU lo que
> se quiere es justamente que las bibliotecas numéricas los usen.
>
> Si aun así el Space queda en error y no hay logs, el motivo está en la API:
>
> ```bash
> curl -s https://huggingface.co/api/spaces/<usuario>/<space> \
>   | python3 -c "import json,sys; print(json.load(sys.stdin)['runtime'])"
> ```
>
> El workflow de deploy hace exactamente eso al terminar y falla con el mensaje
> a la vista, así que este comando solo hace falta si el Space se rompió por
> fuera de un deploy.

**3 · Conectar el repo.** El Space es un repo de git propio; el workflow
`.github/workflows/deploy-docverify.yml` lo mantiene sincronizado con
`docverify-api/` en cada push a `main`. Hace falta configurarlo una vez en
GitHub (Settings del repo):

| Dónde | Nombre | Valor |
|---|---|---|
| Secrets → Actions | `HF_TOKEN` | un token de Hugging Face con permiso **write** |
| Variables → Actions | `HF_SPACE` | `tu-usuario/freewheel-docverify` |

Después, **Actions → deploy docverify → Run workflow** para la primera
publicación (o simplemente pushear algo que toque `docverify-api/`).

**4 · Esperar el build.** En la pestaña **Logs** del Space. El primer build
tarda 8-15 minutos: baja ~300 MB de wheels. Cuando el Space quede en
**Running**, la URL es
`https://<usuario>-freewheel-docverify.hf.space`.

**5 · Comprobar.**

```bash
curl https://<usuario>-freewheel-docverify.hf.space/health
```

El campo que importa es `protegido_con_token: true`: el token quedó puesto.

`ocr_cargado` dice si el motor está abierto **en el proceso que está
corriendo**, no si los modelos están instalados —eso lo están siempre, porque
`rapidocr` los trae adentro del paquete y no se bajan nunca—. Al arrancar, el
servicio dispara esa carga en segundo plano, así que el campo pasa a `true`
solo, en unos segundos. Verlo en `false` recién deployado es normal; verlo en
`false` minutos después significa que la carga falló, y el motivo está en los
logs.

**6 · Conectarlo al backend.** En las variables de entorno del backend:
`DOCVERIFY_URL` con la URL del Space (sin barra final) y `DOCVERIFY_TOKEN` con
el mismo valor del paso 2.

No hace falta base de datos ni disco persistente: esta API no guarda nada, y los
modelos ya están dentro de la imagen.

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
