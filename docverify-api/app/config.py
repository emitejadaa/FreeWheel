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

    concurrencia: int
    """Cuántos análisis corren A LA VEZ. El default es 1 y no es conservadurismo:
    el motor de OCR trabaja sobre imágenes descomprimidas y dos análisis
    simultáneos no entran en una instancia de 512 MB. Subirlo requiere haberle
    dado más memoria a la instancia, no solo más CPU."""

    cola_maxima: int
    """Cuántos análisis se aceptan sin terminar antes de contestar 503. Acota
    cuánto puede crecer la espera de quien ya está en la fila."""

    callback_timeout: float
    """Cuánto se espera al backend al avisarle que un análisis terminó."""


def _cargar() -> Ajustes:
    origenes = os.environ.get("DOCVERIFY_ORIGENES", "").strip()
    return Ajustes(
        token=os.environ.get("DOCVERIFY_TOKEN", "").strip(),
        max_bytes=_entero("DOCVERIFY_MAX_KB", 15_000) * 1024,
        origenes_permitidos=(
            [o.strip() for o in origenes.split(",") if o.strip()] if origenes else ["*"]
        ),
        concurrencia=max(1, _entero("DOCVERIFY_CONCURRENCIA", 1)),
        cola_maxima=max(1, _entero("DOCVERIFY_COLA_MAXIMA", 8)),
        callback_timeout=float(_entero("DOCVERIFY_CALLBACK_TIMEOUT", 20)),
    )


ajustes = _cargar()
