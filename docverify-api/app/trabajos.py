"""
ANALIZAR EN SEGUNDO PLANO Y AVISAR CUANDO ESTÉ.

Por qué esto existe, en una línea: **analizar un documento tarda más de lo que
un request HTTP puede esperar**, y hay dos motivos distintos que empujan en la
misma dirección.

EL PRIMERO ES EL TIEMPO. Leer una cara son 3 a 6 segundos en una máquina de
escritorio, y bastante más en el medio CPU de una instancia chica. Un documento
son DOS caras. Del otro lado, el backend corre en funciones serverless con un
tope duro de 60 segundos: sumando la descarga de las fotos, el análisis
sincrónico entra raspando cuando todo sale bien y no entra cuando no.

EL SEGUNDO ES LA MEMORIA, y es el que de verdad obliga. El motor de OCR carga
sus modelos y trabaja sobre imágenes descomprimidas: dos análisis simultáneos
en una instancia de 512 MB la matan por OOM. O sea que aunque el tiempo
alcanzara, igual haría falta poner los pedidos en fila en vez de atenderlos
todos juntos.

Así que el pedido se ACEPTA (202) y se contesta enseguida, el análisis se hace
en una fila de a uno, y cuando termina se le avisa a quien lo pidió con un POST
a la URL que dejó.

DOS DECISIONES QUE PARECEN DETALLES Y NO LO SON:

  · **El análisis corre en un hilo, no en el event loop.** Es trabajo de CPU
    que dura segundos: puesto directamente en el loop, `/health` deja de
    responder mientras tanto, la plataforma lo interpreta como que el servicio
    murió y lo reinicia. Reiniciarlo en medio de un análisis es perder el
    análisis. El hilo no es una optimización, es lo que mantiene vivo al
    servicio.

  · **La fila tiene tope y se contesta 503 cuando se llena.** Aceptar todo lo
    que llegue haría crecer la cola sin límite: el trabajo entra más rápido de
    lo que sale, la memoria sube y el que pidió primero espera cada vez más sin
    enterarse de nada. Decir "ahora no puedo" es información útil; aceptar y
    tardar veinte minutos, no.
"""

from __future__ import annotations

import asyncio
import gc
import logging
import time
from dataclasses import dataclass

import httpx

from . import contrato
from .config import ajustes
from .documentos import REGISTRO, base as analizador_base

log = logging.getLogger("docverify.trabajos")

# De a uno por vez (o lo que diga la config). El semáforo es lo que evita el
# OOM: no limita cuántos pedidos se aceptan, limita cuántos análisis corren a la
# vez. Se crea perezosamente porque un asyncio.Semaphore hay que construirlo con
# el event loop ya andando.
_turno: asyncio.Semaphore | None = None

# Cuántos trabajos hay aceptados y todavía sin terminar. Es lo que se compara
# contra el tope de la cola, y lo que informa /health.
_pendientes = 0


def _semaforo() -> asyncio.Semaphore:
    global _turno
    if _turno is None:
        _turno = asyncio.Semaphore(ajustes.concurrencia)
    return _turno


def pendientes() -> int:
    return _pendientes


@dataclass
class Pedido:
    """Un documento para analizar y a dónde avisar cuando esté."""

    documento: str
    """"dni" o "licencia"."""

    caras: dict[str, bytes]
    """Los bytes de cada cara: {"frente": ..., "dorso": ...}."""

    referencia: str
    """Identificador de quien pidió el análisis. Viaja de ida y de vuelta sin
    que esta API lo interprete: para nosotros es una cadena opaca que solo
    sirve para que los logs de los dos lados se puedan cruzar."""

    callback_url: str = ""
    """A dónde avisar. Vacío = el cliente espera la respuesta en el request."""

    callback_token: str = ""
    """Lo que se manda como `Authorization: Bearer` al avisar. Es de quien pidió
    el análisis, no nuestro: sirve para que pueda comprobar que el aviso
    corresponde a un pedido que él hizo y no a cualquiera que sepa la URL."""


class ColaLlena(RuntimeError):
    """No se acepta más trabajo por ahora."""


def analizar(pedido: Pedido) -> dict:
    """
    El análisis completo de un documento: las dos caras y sus cruces.

    Sincrónico y sin nada de asyncio: es exactamente lo que se manda al hilo.
    No lanza por un problema de las fotos —una cara ilegible es una cara con
    los campos vacíos— pero sí deja el motivo dentro del sobre de esa cara.
    """
    arranque = time.perf_counter()
    caras: dict[str, dict] = {}

    for lado, datos in pedido.caras.items():
        ruta = f"{pedido.documento}-{lado}"
        analizador = REGISTRO.get(ruta)
        if analizador is None:
            caras[lado] = contrato.error_de_analisis(
                ruta.replace("-", "_"), f"no sé analizar «{ruta}»"
            )
            continue
        caras[lado] = analizador_base.analizar(datos, analizador)
        # Recolectar ENTRE las dos caras, no solo al final.
        #
        # Analizar una cara deja atrás decenas de matrices grandes: la foto, el
        # recorte enderezado, y las copias al doble y al triple que hace el
        # lector de códigos. Python las liberaría solas, pero cuando le venga
        # bien — y en el medio arranca la segunda cara y los dos picos se
        # suman. En una instancia chica esa suma es la diferencia entre
        # terminar y que el sistema mate el proceso.
        gc.collect()

    ms = int((time.perf_counter() - arranque) * 1000)
    log.info(
        "%s analizado en %d ms · %s",
        pedido.documento,
        ms,
        " · ".join(f"{lado}={'ok' if c.get('ok') else 'sin datos'}" for lado, c in caras.items()),
    )
    return contrato.respuesta_documento(pedido.documento, caras, ms)


async def encolar(pedido: Pedido) -> None:
    """
    Acepta el pedido y lo deja andando. Devuelve enseguida: el resultado sale
    por el callback.
    """
    global _pendientes
    if _pendientes >= ajustes.cola_maxima:
        raise ColaLlena(
            f"hay {_pendientes} análisis en curso y el máximo es "
            f"{ajustes.cola_maxima}"
        )
    _pendientes += 1
    asyncio.create_task(_procesar(pedido))


async def analizar_esperando(pedido: Pedido) -> dict:
    """
    El mismo análisis pero devolviendo el resultado, para quien no puede
    recibir un callback (probar a mano con curl, correr todo en una máquina de
    desarrollo sin URL pública). Respeta el mismo turno, así que tampoco puede
    disparar dos análisis en paralelo.
    """
    async with _semaforo():
        return await asyncio.to_thread(analizar, pedido)


async def _procesar(pedido: Pedido) -> None:
    """Esperar el turno, analizar en un hilo y avisar. Nunca lanza."""
    global _pendientes
    try:
        async with _semaforo():
            log.info(
                "analizando %s · ref=%s · %d en cola",
                pedido.documento,
                pedido.referencia,
                _pendientes - 1,
            )
            resultado = await asyncio.to_thread(analizar, pedido)
    except Exception as error:  # noqa: BLE001 — el aviso tiene que salir igual
        log.exception("falló el análisis de %s", pedido.referencia)
        resultado = {
            "ok": False,
            "documento": pedido.documento,
            "version": contrato.VERSION_CONTRATO,
            "ms": 0,
            "caras": {},
            "coincidencias": {},
            "error": f"el análisis falló: {error}",
        }
    finally:
        _pendientes -= 1

    await _avisar(pedido, resultado)


async def _avisar(pedido: Pedido, resultado: dict) -> None:
    """
    El POST de vuelta, con reintentos.

    SE REINTENTA PORQUE ACÁ NO HAY RED DE CONTENCIÓN. Esta API no guarda nada:
    si el aviso se pierde, el análisis se perdió, y del otro lado queda un
    documento esperando para siempre un resultado que ya se calculó. Volver a
    intentar es más barato que volver a analizar.

    Se reintenta solo lo que puede mejorar con el tiempo: un problema de red o
    un 5xx del backend. Un 4xx significa que el backend entendió el pedido y lo
    rechazó —un token que ya se usó, una referencia que no existe— y repetirlo
    da exactamente lo mismo.
    """
    if not pedido.callback_url:
        return

    cuerpo = {"referencia": pedido.referencia, "resultado": resultado}
    cabeceras = {}
    if pedido.callback_token:
        cabeceras["Authorization"] = f"Bearer {pedido.callback_token}"

    espera = 1.0
    for intento in range(1, 5):
        try:
            async with httpx.AsyncClient(timeout=ajustes.callback_timeout) as cliente:
                respuesta = await cliente.post(
                    pedido.callback_url, json=cuerpo, headers=cabeceras
                )
            if respuesta.status_code < 300:
                log.info(
                    "aviso entregado · ref=%s · %d",
                    pedido.referencia,
                    respuesta.status_code,
                )
                return
            if respuesta.status_code < 500:
                log.error(
                    "el backend rechazó el aviso de %s con %d: %s. No se "
                    "reintenta: un 4xx no cambia repitiéndolo.",
                    pedido.referencia,
                    respuesta.status_code,
                    respuesta.text[:300],
                )
                return
            motivo = f"el backend respondió {respuesta.status_code}"
        except httpx.HTTPError as error:
            motivo = f"no se pudo llegar al backend ({error})"

        if intento == 4:
            log.error(
                "el aviso de %s no se pudo entregar después de 4 intentos: %s",
                pedido.referencia,
                motivo,
            )
            return

        log.warning(
            "intento %d de avisar %s falló (%s); reintento en %.0fs",
            intento,
            pedido.referencia,
            motivo,
            espera,
        )
        await asyncio.sleep(espera)
        espera *= 2
