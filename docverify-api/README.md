# docverify-api

Lee el DNI y la licencia de conducir argentinos a partir de fotos: encuadra el documento y extrae sus datos por OCR, PDF417, MRZ y código de barras. No guarda nada.

## Requisitos

- Python 3.11 o superior (probada con 3.13)
- 2 GB de RAM como mínimo: con menos, un análisis de las dos caras no termina
- En Linux sin entorno gráfico: `sudo apt install libgl1 libglib2.0-0`

## Instalación

```bash
cd docverify-api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
```

En `.env`, `DOCVERIFY_TOKEN` tiene que tener un valor largo y al azar (`openssl rand -hex 32`) y ser el mismo que el `DOCVERIFY_TOKEN` del backend. Vacío, la API acepta pedidos de cualquiera.

## Ejecución

```bash
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --env-file .env
```

Un solo worker: cada uno carga su propio motor de OCR en memoria. `GET /health` responde apenas arranca y muestra `ocr_cargado: true` unos segundos después.

## Configuración

| Variable | Default | Uso |
|---|---|---|
| `DOCVERIFY_TOKEN` | vacío | Token que se exige en `X-Docverify-Token` o `Authorization: Bearer` |
| `DOCVERIFY_ORIGENES` | `*` | Orígenes permitidos por CORS, separados por coma |
| `DOCVERIFY_MAX_KB` | `15000` | Tamaño máximo de cada imagen |
| `DOCVERIFY_CONCURRENCIA` | `1` | Análisis simultáneos. Cada uno suma memoria |
| `DOCVERIFY_COLA_MAXIMA` | `8` | Análisis en espera antes de responder 503 |
| `DOCVERIFY_CALLBACK_TIMEOUT` | `20` | Segundos de espera al avisar al backend |
| `DOCVERIFY_LADO_MAXIMO` | `2400` | Lado máximo en píxeles al que se reduce cada foto |

## Endpoints

| Método | Ruta | |
|---|---|---|
| `GET` | `/health` | Estado del servicio |
| `GET` | `/contrato` | Campos que devuelve cada documento |
| `POST` | `/analizar/documento` | Frente y dorso en base64. Con `callback_url` responde 202 y avisa al terminar; sin ella, responde el resultado |
| `POST` | `/analizar/{dni-frente,dni-dorso,licencia-frente,licencia-dorso}` | Una cara, como archivo multipart en el campo `imagen` |

La documentación interactiva queda en `/docs`.
