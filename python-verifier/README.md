# Verificador de documentos (subproyecto Python)

Subproyecto **aislado** cuya única función es extraer datos de las fotos de
DNI y licencia de conducir argentinos, y devolverlos como JSON. No decide
nada: la comparación de datos y el veredicto de verificación viven en el
backend NestJS, que es el único que lo invoca.

Se puede invocar de **dos formas**, con el mismo contrato de entrada y salida:

| | Cómo | Cuándo |
|---|---|---|
| **Subproceso** | `analyze.py`, JSON por stdin → JSON por stdout. No abre puertos ni escucha red. | Desarrollo local |
| **HTTP** | `server.py`, `POST /analyze` con las fotos en base64 | El deploy (ver abajo) y el front demo local |

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

## Probarlo en el navegador, sin backend

El front de prueba de la verificación (`public/demo/verificacion.html`) tiene
una sección **"Verificador Python en tu máquina"**: manda las fotos que
cargaste directo a este servidor y muestra campo por campo lo que leyó cada
protocolo, sin NestJS, sin cuenta, sin Cloudinary y sin base de datos. Sirve
para trabajar la lectura mientras se decide dónde va a correr el Python.

```bash
# 1. levantar el verificador con CORS prendido
DOCVERIFY_ALLOW_ANONYMOUS=true DOCVERIFY_CORS_ORIGIN='*' .venv/bin/python server.py

# 2. abrir el demo: es un HTML suelto, no hace falta servidor
xdg-open ../public/demo/verificacion.html
```

`DOCVERIFY_CORS_ORIGIN` **no es opcional para esto**: sin ella el navegador
descarta la respuesta y el front solo puede decir "NetworkError". El server lo
avisa una vez en su propia consola (`un navegador (origen 'null') pidió … y
CORS está apagado`), y el front lo diagnostica solo: distingue "no hay nadie
escuchando" de "contestó pero le falta CORS". Acepta `*`, o los orígenes
separados por coma (el archivo abierto con `file://` manda `null`).

El servidor escucha en **IPv4 e IPv6** donde la máquina tenga las dos: si
quedara solo en IPv4, un navegador que resuelva `localhost` a `::1` fallaría
con un error de red idéntico al de "no está levantado". El arranque dice cuál
de las dos consiguió.

Por defecto está **apagada**, que es lo que corresponde en el deploy: ahí el
único que llama es el backend, servidor contra servidor, y con CORS abierto
cualquier página que la persona visite podría mandarle documentos a este
servidor desde su navegador.

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

El `Dockerfile` ya trae tesseract con español y corre sin root. Sirve igual en
Render, Railway, Fly, ECS o un VPS: no hay nada atado a un host.

```bash
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

Importa sobre todo con planes que apagan el servicio por inactividad: el primer
pedido después de dormir puede tardar un minuto entero.

## Módulos

Seis, más los tests. Cada uno tiene un test con su nombre.

- `analyze.py` — el análisis (`analizar()`, las fotos en paralelo) y la entrada
  por stdin/stdout. Lo que corre el backend como subproceso.
- `server.py` — la otra entrada, HTTP, sobre el mismo `analizar()`.
- `contrato.py` — la forma de la salida y la de los errores.
- `imagen.py` — abrir la foto, enderezarla (bordes, perspectiva, orientación) y
  el probador de rotaciones que usan los tres lugares que tienen que decidir
  para qué lado va la tarjeta.
- `codigos.py` — los dos protocolos que se validan solos: PDF417 (zxing-cpp) y
  MRZ TD1 con sus dígitos verificadores.
- `campos.py` — las zonas de la tarjeta y todo el OCR: campos por posición, MRZ
  del dorso y dorso de licencia.
- `normalizadores.py` — limpieza de valores crudos (fechas, nombres, CUIL). No
  importa nada del subproyecto: lo usan tanto los códigos como el OCR.
