"""
Forma única de resultado en todo el verificador: salió bien y hay datos, o
salió mal y hay un motivo con código y mensaje. Nunca una excepción suelta,
nunca un None sin explicación.
"""

from __future__ import annotations

import traceback
from typing import Any


def ok(**datos: Any) -> dict:
    return {"ok": True, **datos}


def error(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message}}


def desde_excepcion(code: str, exc: BaseException) -> dict:
    """Convierte una excepción en un error con el traceback corto adentro."""
    detalle = "".join(
        traceback.format_exception(type(exc), exc, exc.__traceback__)
    )[-600:]
    return {
        "ok": False,
        "error": {
            "code": code,
            "message": f"{type(exc).__name__}: {exc}",
            "detail": detalle,
        },
    }
