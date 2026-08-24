# Verificador de documentos (subproyecto Python)

Subproyecto **aislado** cuya única función es extraer datos de las fotos de
DNI y licencia de conducir argentinos, y devolverlos como JSON. No decide
nada: la comparación de datos y el veredicto de verificación viven en el
backend NestJS, que es el único que lo invoca (como subproceso, vía
`analyze.py`). No abre puertos ni escucha red.

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
