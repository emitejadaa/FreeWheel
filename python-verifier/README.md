# Verificador de documentos (subproyecto Python)

Subproyecto **aislado** cuya única función es extraer datos de las fotos de
DNI y licencia de conducir argentinos, y devolverlos como JSON. No decide
nada: la comparación de datos y el veredicto de verificación viven en el
backend NestJS, que es el único que lo invoca.

Se puede invocar de **dos formas**, con el mismo contrato de entrada y salida:

| | Cómo | Cuándo |
|---|---|---|
| **Subproceso** | `analyze.py`, JSON por stdin → JSON por stdout. No abre puertos ni escucha red. | Desarrollo local |
| **HTTP** | `server.py`, `POST /analyze` con las fotos en base64 | El deploy (ver abajo) |

## Qué hace por foto

| Foto | Protocolos | Campos |
|---|---|---|
| `dni_front` | `ocr` + `codigo` (PDF417) | apellido, nombre, sexo, nDocumento, fechaNacimiento, fechaEmision, fechaVencimiento (ocr) / los mismos sin vencimiento (codigo) |
| `dni_back` | `ocr` + `mrz` | domicilio, cuil (ocr) / apellido, nombre, sexo, nDocumento, fechaNacimiento, fechaVencimiento (mrz) |
| `license_front` | `ocr` | numLicencia, apellido, nombre, domicilio, fechaNacimiento, fechaVencimiento |
| `license_back` | `ocr` | cuil, esPrincipiante, finPrincipiante |

El contrato exacto de entrada/salida está en `contrato.py` (única
definición) y sus reglas en el docstring de `analyze.py`.

## Instalación

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# + el binario de tesseract con español (ver requirements.txt)
```

## Probar a mano

```bash
echo '{"documentos": {"dni_front": "testDocuments/dniFrente.jpeg"}}' \
    | .venv/bin/python analyze.py
```

## Tests

```bash
.venv/bin/python -m pytest
```

## Desplegarlo (obligatorio para que la verificación funcione en el deploy)

El backend de FreeWheel corre en **Vercel serverless**, donde no hay Python ni
el binario de tesseract y **no los puede haber**: son dependencias del sistema
operativo, no paquetes de npm. Ahí el subproceso es imposible, así que este
verificador tiene que correr **en otro lado** y el backend le habla por HTTP.

Sin esto, la revisión automática no corre: los documentos quedan fallados con
el motivo "la verificación automática no está disponible en este servidor", y la
persona puede reenviar fotos o pedir revisión de un admin.

### 1. Levantarlo

Hay un `Dockerfile` que ya trae tesseract con español, y configs listas para
los dos hosts más simples:

```bash
# Render (plan free): New → Blueprint → apuntá a python-verifier/render.yaml

# Fly.io
cd python-verifier
fly launch --no-deploy --copy-config
fly secrets set DOCVERIFY_TOKEN="$(openssl rand -hex 32)"
fly deploy

# O a mano, donde sea que corra un contenedor
docker build -t freewheel-docverify .
docker run -p 8000:8000 -e DOCVERIFY_TOKEN="$(openssl rand -hex 32)" freewheel-docverify
```

`DOCVERIFY_TOKEN` **no es opcional**: sin él el servidor se niega a arrancar.
Esto recibe documentos de identidad de gente real y quedaría abierto a
cualquiera que descubra la URL. (Solo para probar en tu máquina existe
`DOCVERIFY_ALLOW_ANONYMOUS=true`.)

### 2. Apuntarle desde el backend

En las variables de entorno del backend:

```
DOCVERIFY_URL=https://<donde-quedó>      # sin barra final
DOCVERIFY_TOKEN=<la misma clave>
DOCVERIFY_TIMEOUT_MS=50000               # ver la nota de abajo
```

### 3. Comprobar que quedó bien

```bash
curl https://<donde-quedó>/health
# {"ok":true,"version":"1.0","tesseract":"tesseract 5.5.0",...}
```

Y desde el backend, con cualquier sesión iniciada:

```
GET /verification/identity/diagnostics
# "mode": "auto", "verifier": {"transport":"remote","reachable":true, ...}
```

Si `ok` es `false` o `tesseract` es `null`, el contenedor levantó sin el binario
de tesseract: el OCR no corre y todo documento va a fallar.

### La nota del timeout

Vercel corta sus funciones a los **60 segundos**. El backend espera al
verificador hasta `DOCVERIFY_TIMEOUT_MS` (120 s por defecto), así que en Vercel
conviene bajarlo a ~50 s: así el backend contesta "el verificador remoto no
contestó" —un motivo entendible, con la posibilidad de reintentar— en vez de que
Vercel mate la función sin explicación.

Importa sobre todo con planes que apagan el servicio por inactividad (el free de
Render): el primer pedido después de dormir puede tardar un minuto entero.

## Módulos

- `analyze.py` — punto de entrada: JSON por stdin → JSON por stdout.
- `contrato.py` — la forma de la salida (qué objeto y campos por foto).
- `imagenes.py` — apertura de la foto y variantes para el código de barras.
- `codigos_barras.py` — PDF417 del DNI (zxing-cpp) y su parser.
- `mrz.py` — parser TD1 con dígitos verificadores.
- `document_geometry.py` — bordes, perspectiva y orientación (OpenCV + OSD).
- `zonas_documento.py` — dónde está cada campo en la tarjeta rectificada.
- `extraccion_campos.py` — OCR posicional, MRZ del dorso, dorso de licencia.
- `normalizadores_campos.py` — limpieza e interpretación de valores crudos.
