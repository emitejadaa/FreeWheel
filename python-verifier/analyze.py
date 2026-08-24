#!/usr/bin/env python3
"""
VERIFICADOR DE DOCUMENTOS — punto de entrada
============================================

Única puerta de entrada al subproyecto: un proceso que lee UN pedido JSON por
stdin, analiza las fotos indicadas y escribe UN resultado JSON por stdout.
No abre puertos, no escucha red, no escribe archivos: solo lee las rutas que
le pasa el backend y contesta. Terminó, y el proceso muere.

Pedido:

    {"documentos": {"dni_front": "/ruta/foto.jpg", "dni_back": "/ruta/otra.jpg"}}

Respuesta: ver contrato.py. Cada foto devuelve un objeto por protocolo con
`title` y todos los atributos extraíbles de ese caso (null si no se
detectaron). Ningún fallo de una foto corta el análisis de las demás.

Uso manual (para probar a mano):

    echo '{"documentos": {"dni_front": "testDocuments/dniFrente.jpeg"}}' \
        | .venv/bin/python analyze.py
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor

from codigos_barras import decodificar_pdf417_dni
from contrato import SLOTS, armar_slot, slot_no_procesable
from extraccion_campos import construir_campos
from imagenes import abrir_imagen_desde_archivo
from resultado import desde_excepcion

VERSION = "1.0"


def analizar_slot(slot: str, ruta: str) -> dict:
    apertura = abrir_imagen_desde_archivo(ruta)
    if not apertura["ok"]:
        return slot_no_procesable(slot, apertura["error"])

    imagen = apertura["imagen"]

    codigo = None
    if slot == "dni_front":
        try:
            codigo = decodificar_pdf417_dni(imagen)
        except BaseException as exc:  # noqa: BLE001 - un protocolo no corta al otro
            codigo = desde_excepcion("CODIGO_EXCEPCION_INESPERADA", exc)

    try:
        campos = construir_campos(slot, imagen)
    except BaseException as exc:  # noqa: BLE001
        fallo = desde_excepcion("OCR_EXCEPCION_INESPERADA", exc)
        resultado = slot_no_procesable(slot, fallo["error"])
        if slot == "dni_front":
            # El código sí se pudo (o no) decodificar por su cuenta.
            resultado.update(armar_slot(slot, {}, codigo))
            resultado["error"] = {
                "code": fallo["error"]["code"],
                "message": fallo["error"]["message"],
            }
        return resultado

    return armar_slot(slot, campos, codigo)


def main() -> int:
    try:
        pedido = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump(
            {"ok": False, "error": {"code": "PEDIDO_INVALIDO", "message": f"El pedido no es JSON: {exc}"}},
            sys.stdout,
            ensure_ascii=False,
        )
        return 1

    documentos = pedido.get("documentos") if isinstance(pedido, dict) else None
    if not isinstance(documentos, dict) or not documentos:
        json.dump(
            {
                "ok": False,
                "error": {
                    "code": "PEDIDO_INVALIDO",
                    "message": 'El pedido debe traer {"documentos": {"<slot>": "<ruta>"}}.',
                },
            },
            sys.stdout,
            ensure_ascii=False,
        )
        return 1

    desconocidos = [slot for slot in documentos if slot not in SLOTS]
    if desconocidos:
        json.dump(
            {
                "ok": False,
                "error": {
                    "code": "SLOT_DESCONOCIDO",
                    "message": f"Slots desconocidos: {', '.join(desconocidos)}. "
                    f"Válidos: {', '.join(SLOTS)}.",
                },
            },
            sys.stdout,
            ensure_ascii=False,
        )
        return 1

    def analizar_protegido(slot: str, ruta: str) -> dict:
        try:
            return analizar_slot(slot, ruta)
        except BaseException as exc:  # noqa: BLE001 - una foto no corta a las demás
            fallo = desde_excepcion("EXCEPCION_INESPERADA", exc)
            return slot_no_procesable(slot, fallo["error"])

    # Las fotos se analizan en paralelo: el trabajo pesado (Tesseract) corre
    # en subprocesos, así que los hilos no pelean por el GIL.
    salida = {"ok": True, "version": VERSION, "documentos": {}}
    with ThreadPoolExecutor(max_workers=min(4, len(documentos))) as pool:
        futuros = {
            slot: pool.submit(analizar_protegido, slot, str(ruta))
            for slot, ruta in documentos.items()
        }
    salida["documentos"] = {slot: futuro.result() for slot, futuro in futuros.items()}

    json.dump(salida, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
