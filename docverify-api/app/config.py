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

    expuesto: bool
    """Si este proceso está publicado en internet.

    Se deduce del entorno de la plataforma, no de una variable que haya que
    acordarse de poner: en Hugging Face Spaces existe SPACE_ID, en Render
    RENDER_SERVICE_ID. Cuando es cierto, arrancar sin token es un error y no un
    modo de desarrollo (ver `verificar`)."""


def _cargar() -> Ajustes:
    origenes = os.environ.get("DOCVERIFY_ORIGENES", "").strip()
    publicado = any(
        os.environ.get(nombre)
        for nombre in ("SPACE_ID", "RENDER_SERVICE_ID", "DOCVERIFY_EXPUESTO")
    )
    return Ajustes(
        token=os.environ.get("DOCVERIFY_TOKEN", "").strip(),
        max_bytes=_entero("DOCVERIFY_MAX_KB", 15_000) * 1024,
        # Vacío significa cosas distintas según dónde corra, y tiene que ser
        # así: en local "cualquier origen" es lo cómodo para abrir el HTML de
        # prueba; publicado, es una puerta que nadie pidió. El backend llama a
        # esta API desde el servidor, donde CORS no interviene, así que cerrarla
        # no le saca nada a nadie — y deja afuera la página que un tercero
        # arme para que el navegador de una víctima le mande sus documentos.
        origenes_permitidos=(
            [o.strip() for o in origenes.split(",") if o.strip()]
            if origenes
            else ([] if publicado else ["*"])
        ),
        concurrencia=max(1, _entero("DOCVERIFY_CONCURRENCIA", 1)),
        cola_maxima=max(1, _entero("DOCVERIFY_COLA_MAXIMA", 8)),
        callback_timeout=float(_entero("DOCVERIFY_CALLBACK_TIMEOUT", 20)),
        expuesto=publicado,
    )


ajustes = _cargar()


def verificar(ajustes: Ajustes) -> None:
    """
    Se niega a arrancar sin token cuando el servicio está publicado.

    POR ACÁ PASAN DOCUMENTOS DE IDENTIDAD DE PERSONAS REALES. Sin token, para
    mandarle lo que sea a esta API alcanza con conocer la URL — y la URL de un
    Space de Hugging Face es pública y buscable.

    En local sigue arrancando sin nada, que es lo que se quiere para probar: la
    diferencia no la marca una variable que haya que acordarse de poner, sino
    que la plataforma diga que esto está publicado. El olvido peligroso es
    "deployé y me olvidé el token", y ese es justo el que este chequeo corta.

    Falla al ARRANCAR y no en cada request a propósito: un servicio que no
    levanta se ve en el primer deploy, mientras que uno que contesta 500 se
    descubre cuando alguien intenta verificarse.
    """
    if ajustes.expuesto and not ajustes.token:
        raise RuntimeError(
            "DOCVERIFY_TOKEN está vacío y este servicio está publicado en "
            "internet. Por acá pasan documentos de identidad: sin token, "
            "cualquiera que sepa la URL puede usarlo. Cargá el secreto en la "
            "configuración de la plataforma y volvé a deployar."
        )
