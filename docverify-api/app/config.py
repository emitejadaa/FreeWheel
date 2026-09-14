"""
La configuración del servicio. Todo por variables de entorno, todo con un
default que funciona: la API tiene que poder levantarse sin ningún .env.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _entero(nombre: str, defecto: int) -> int:
    crudo = os.environ.get(nombre, "").strip()
    if not crudo:
        return defecto
    try:
        return int(crudo)
    except ValueError:
        return defecto


@dataclass(frozen=True)
class Ajustes:
    token: str
    """Clave compartida. Vacía = API abierta (lo que se quiere en local)."""

    max_bytes: int
    """Tope de tamaño de imagen. Una foto de teléfono ronda los 2-4 MB."""

    origenes_permitidos: list[str]
    """Orígenes que pueden llamar desde un navegador (CORS)."""


def _cargar() -> Ajustes:
    origenes = os.environ.get("DOCVERIFY_ORIGENES", "").strip()
    return Ajustes(
        token=os.environ.get("DOCVERIFY_TOKEN", "").strip(),
        max_bytes=_entero("DOCVERIFY_MAX_KB", 15_000) * 1024,
        origenes_permitidos=(
            [o.strip() for o in origenes.split(",") if o.strip()] if origenes else ["*"]
        ),
    )


ajustes = _cargar()
