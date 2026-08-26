#!/usr/bin/env python3
"""
VERIFICADOR DE DOCUMENTOS — el análisis y la entrada por stdin/stdout
====================================================================

Lee UN pedido JSON por stdin, analiza las fotos indicadas y escribe UN
resultado JSON por stdout. No abre puertos, no escucha red, no escribe
archivos: solo lee las rutas que le pasa el backend y contesta. Terminó, y el
proceso muere.

    {"documentos": {"dni_front": "/ruta/foto.jpg", "dni_back": "/ruta/otra.jpg"}}

Respuesta: ver contrato.py. Cada foto devuelve un objeto por protocolo con
`title` y todos los atributos extraíbles de ese caso (null si no se
detectaron). Ningún fallo de una foto corta el análisis de las demás.

`analizar()` es también lo que usa server.py para el transporte HTTP: los dos
caminos comparten el análisis, la validación del pedido y el paralelismo, y
por eso devuelven exactamente el mismo JSON.

Uso manual (para probar a mano):

    echo '{"documentos": {"dni_front": "testDocuments/dniFrente.jpeg"}}' \\
        | .venv/bin/python analyze.py
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from campos import construir_campos
from codigos import decodificar_pdf417_dni
from contrato import SLOTS, armar_slot, desde_excepcion, error, slot_no_procesable
from imagen import abrir_imagen_desde_archivo

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


def validar_pedido(documentos: Any) -> dict | None:
    """El error del pedido, o None si está bien. Lo comparten las dos
    entradas: el mismo pedido mal armado tiene que fallar igual por stdin
    que por HTTP."""
    if not isinstance(documentos, dict) or not documentos:
        return error(
            "PEDIDO_INVALIDO",
            'El pedido debe traer {"documentos": {"<slot>": "<foto>"}}.',
        )
    desconocidos = [slot for slot in documentos if slot not in SLOTS]
    if desconocidos:
        return error(
            "SLOT_DESCONOCIDO",
            f"Slots desconocidos: {', '.join(desconocidos)}. "
            f"Válidos: {', '.join(SLOTS)}.",
        )
    return None


def analizar(rutas: dict[str, str]) -> dict:
    """{slot: ruta} → el JSON de contrato con todas las fotos analizadas.

    Las fotos van en paralelo: el trabajo pesado (Tesseract) corre en
    subprocesos, así que los hilos no pelean por el GIL. Una foto que explota
    no corta a las demás: queda con su motivo y el resto se analiza igual.
    """
    def protegido(slot: str, ruta: str) -> dict:
        try:
            return analizar_slot(slot, ruta)
        except BaseException as exc:  # noqa: BLE001 - una foto no corta a las demás
            return slot_no_procesable(slot, desde_excepcion("EXCEPCION_INESPERADA", exc)["error"])

    with ThreadPoolExecutor(max_workers=min(4, len(rutas))) as pool:
        futuros = {
            slot: pool.submit(protegido, slot, str(ruta)) for slot, ruta in rutas.items()
        }
    return {
        "ok": True,
        "version": VERSION,
        "documentos": {slot: futuro.result() for slot, futuro in futuros.items()},
    }


def main() -> int:
    try:
        pedido = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump(error("PEDIDO_INVALIDO", f"El pedido no es JSON: {exc}"), sys.stdout, ensure_ascii=False)
        return 1

    documentos = pedido.get("documentos") if isinstance(pedido, dict) else None
    fallo = validar_pedido(documentos)
    if fallo:
        json.dump(fallo, sys.stdout, ensure_ascii=False)
        return 1

    json.dump(analizar(documentos), sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
