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

Uno por **cara** de documento, porque cada cara se lee distinto:

| Endpoint | Orígenes que devuelve |
|---|---|
| `POST /analizar/dni-frente` | `ocr` · `pdf417` |
| `POST /analizar/dni-dorso` | `ocr` · `mrz` · `qr`* |
| `POST /analizar/licencia-frente` | `ocr` · `qr`* |
| `POST /analizar/licencia-dorso` | `ocr` · `pdf417` · `codigo_1d` |

\* con `disponible: false`: ese documento no tiene ese código. No es un fallo.

Además: `GET /health` (estado) y `GET /contrato` (qué campos devuelve cada
endpoint, sin tener que mandar una foto para averiguarlo).

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
  "version": "1.0.0",
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
    "ejemplar": "Letra del ejemplar del DNI (A, B, C...)"
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

---

## Cómo lee cada documento

### DNI frente — OCR + PDF417
Los dos orígenes traen casi los mismos campos, y ahí está la gracia: se pueden
cruzar. El **vencimiento es la excepción**: no está codificado en el PDF417, así
que solo existe impreso y no se puede contrastar contra nada.

### DNI dorso — OCR + MRZ
División tajante. El **domicilio, el lugar de nacimiento y el CUIL** existen
únicamente impresos. La **MRZ** (las tres líneas de `<<<` del pie) trae apellido,
nombre, sexo, documento y vencimiento **con sus dígitos verificadores**: es la
única lectura del documento que puede demostrar por sí sola que se leyó bien.

### Licencia frente — solo OCR
No tiene ningún código. Sus datos solo se pueden contrastar contra el dorso.

### Licencia dorso — OCR + PDF417 + código 1D
El más rico. El dato que importa sacar bien es el **período de principiante**
("Principiante hasta 28/10/2026"), que determina si la persona puede manejar
sin acompañante y no está en ningún código: es OCR o nada.

---

## Configuración

Todo opcional — sin `.env` el servicio levanta y funciona. Ver `.env.example`.

| Variable | Para qué |
|---|---|
| `DOCVERIFY_TOKEN` | Exige `Authorization: Bearer <token>`. Vacío = abierto. |
| `DOCVERIFY_ORIGENES` | Orígenes permitidos por CORS, separados por coma. |
| `DOCVERIFY_MAX_KB` | Tope de tamaño de imagen (default 15.000 KB). |

En un deploy expuesto a internet **poné el token**: por acá pasan documentos de
identidad de personas reales, y sin token alcanza con conocer la URL.

---

## Deploy

Todo se instala con `pip` — no hace falta ningún binario del sistema (ni
Tesseract ni zbar), así que el deploy es igual en Windows y en Linux y no
necesita un `Dockerfile` con `apt-get`.

```bash
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

Hay un `Dockerfile` para las plataformas que lo prefieran. **No conviene
serverless**: cada arranque en frío recargaría los modelos de OCR.

---

## Qué esperar de la extracción

Medido contra las cuatro fotos de `public/images/` (fotos de teléfono reales,
con reflejos, una de ellas sacada de costado):

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
- **`grupo_sanguineo` sale vacío en la licencia y está bien:** el documento
  tiene un guion ahí, o sea que el dato no está cargado.

El tiempo por análisis ronda los **3 a 6 segundos** en una máquina de escritorio.
