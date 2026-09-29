import asyncio
import base64
import logging
import os
import secrets
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import documentos
from .imagen import motor, motor_cargado


def _entero(nombre: str, defecto: int) -> int:
    try:
        return int(os.environ.get(nombre, "").strip() or defecto)
    except ValueError:
        return defecto


TOKEN = os.environ.get("DOCVERIFY_TOKEN", "").strip()
ORIGENES = [o.strip() for o in os.environ.get("DOCVERIFY_ORIGENES", "").split(",") if o.strip()] or ["*"]
MAX_BYTES = _entero("DOCVERIFY_MAX_KB", 15_000) * 1024
CONCURRENCIA = max(1, _entero("DOCVERIFY_CONCURRENCIA", 1))
COLA_MAXIMA = max(1, _entero("DOCVERIFY_COLA_MAXIMA", 8))
CALLBACK_TIMEOUT = float(_entero("DOCVERIFY_CALLBACK_TIMEOUT", 20))
LADO_MAXIMO = _entero("DOCVERIFY_LADO_MAXIMO", 2400)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s · %(message)s")
log = logging.getLogger("docverify")


@dataclass
class Trabajo:
    documento: str
    caras: dict[str, bytes]
    referencia: str
    callback_url: str
    callback_token: str


class Cola:
    def __init__(self) -> None:
        self.turno = asyncio.Semaphore(CONCURRENCIA)
        self.pendientes = 0
        self.tareas: set[asyncio.Task] = set()

    async def ejecutar(self, analisis: Callable[..., dict], *argumentos) -> dict:
        async with self.turno:
            resultado = await asyncio.to_thread(analisis, *argumentos, LADO_MAXIMO)
        log.info("%s analizado en %d ms · ok=%s", resultado["documento"], resultado["ms"], resultado["ok"])
        return resultado

    async def analizar(self, trabajo: Trabajo) -> dict:
        return await self.ejecutar(documentos.analizar_documento, trabajo.documento, trabajo.caras)

    def encolar(self, trabajo: Trabajo) -> None:
        if self.pendientes >= COLA_MAXIMA:
            raise HTTPException(
                503,
                f"la API está saturada: hay {self.pendientes} análisis en curso y el máximo es {COLA_MAXIMA}. "
                "Reintentá en un rato.",
                headers={"Retry-After": "60"},
            )
        self.pendientes += 1
        tarea = asyncio.create_task(self._procesar(trabajo))
        self.tareas.add(tarea)
        tarea.add_done_callback(self.tareas.discard)

    async def _procesar(self, trabajo: Trabajo) -> None:
        try:
            resultado = await self.analizar(trabajo)
        except Exception as error:
            log.exception("falló el análisis de %s", trabajo.referencia)
            resultado = documentos.error_de_documento(trabajo.documento, f"el análisis falló: {error}")
        finally:
            self.pendientes -= 1
        await _avisar(trabajo, resultado)


async def _avisar(trabajo: Trabajo, resultado: dict) -> None:
    cuerpo = {"referencia": trabajo.referencia, "resultado": resultado}
    cabeceras = {"Authorization": f"Bearer {trabajo.callback_token}"} if trabajo.callback_token else {}
    async with httpx.AsyncClient(timeout=CALLBACK_TIMEOUT) as cliente:
        for espera in (1, 2, 4, 0):
            try:
                respuesta = await cliente.post(trabajo.callback_url, json=cuerpo, headers=cabeceras)
            except httpx.HTTPError as error:
                motivo = f"no se pudo llegar al backend ({error})"
            else:
                if respuesta.status_code < 300:
                    log.info("aviso entregado · ref=%s · %d", trabajo.referencia, respuesta.status_code)
                    return
                if respuesta.status_code < 500:
                    log.error(
                        "el backend rechazó el aviso de %s con %d: %s",
                        trabajo.referencia,
                        respuesta.status_code,
                        respuesta.text[:300],
                    )
                    return
                motivo = f"el backend respondió {respuesta.status_code}"
            if espera:
                log.warning("no se pudo avisar %s (%s); reintento en %ds", trabajo.referencia, motivo, espera)
                await asyncio.sleep(espera)
    log.error("el aviso de %s no se pudo entregar después de 4 intentos: %s", trabajo.referencia, motivo)


cola = Cola()


@asynccontextmanager
async def ciclo_de_vida(_: FastAPI):
    if not TOKEN:
        log.warning("DOCVERIFY_TOKEN está vacío: la API acepta pedidos de cualquiera")
    carga = asyncio.create_task(asyncio.to_thread(motor))
    carga.add_done_callback(_informar_carga)
    yield


def _informar_carga(carga: asyncio.Task) -> None:
    if carga.cancelled():
        return
    if carga.exception():
        log.error("el motor de OCR no cargó al arrancar: %s", carga.exception())
    else:
        log.info("motor de OCR listo")


app = FastAPI(title="FreeWheel · API de verificación documental", version=documentos.VERSION, lifespan=ciclo_de_vida)
app.add_middleware(
    CORSMiddleware, allow_origins=ORIGENES, allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"]
)


def autorizar(
    authorization: Annotated[str | None, Header()] = None,
    x_docverify_token: Annotated[str | None, Header()] = None,
) -> None:
    if not TOKEN:
        return
    presentados = (x_docverify_token or "", (authorization or "").removeprefix("Bearer "))
    if not any(secrets.compare_digest(p.encode(), TOKEN.encode()) for p in presentados):
        raise HTTPException(
            401,
            "token inválido o ausente: mandalo en el header 'X-Docverify-Token' o como 'Authorization: Bearer <token>'",
        )


def _controlar_tamano(datos: bytes, nombre: str) -> None:
    if len(datos) > MAX_BYTES:
        raise HTTPException(413, f"{nombre} pesa {len(datos) // 1024} KB y el máximo es {MAX_BYTES // 1024} KB")


def _decodificar(crudo: str, cara: str) -> bytes:
    limpio = crudo.strip()
    if not limpio:
        raise HTTPException(400, f"falta la imagen del {cara}")
    if limpio.startswith("data:"):
        limpio = limpio.partition(",")[2]
    try:
        datos = base64.b64decode(limpio, validate=True)
    except ValueError as error:
        raise HTTPException(400, f"el base64 del {cara} no es válido: {error}") from error
    if not datos:
        raise HTTPException(400, f"la imagen del {cara} llegó vacía")
    _controlar_tamano(datos, f"la imagen del {cara}")
    return datos


class PedidoDocumento(BaseModel):
    documento: str
    frente_base64: str
    dorso_base64: str
    referencia: str = ""
    callback_url: str = ""
    callback_token: str = ""


@app.get("/health")
def salud() -> dict:
    return {
        "ok": True,
        "servicio": "docverify-api",
        "version": documentos.VERSION,
        "documentos": sorted(documentos.DOCUMENTOS),
        "ocr_cargado": motor_cargado(),
        "protegido_con_token": bool(TOKEN),
        "analisis_en_cola": cola.pendientes,
        "analisis_simultaneos": CONCURRENCIA,
    }


@app.get("/contrato")
def contrato() -> dict:
    return documentos.contrato()


@app.post("/analizar/documento", dependencies=[Depends(autorizar)])
async def analizar_documento(pedido: PedidoDocumento) -> JSONResponse:
    if pedido.documento not in ("dni", "licencia"):
        raise HTTPException(400, f'el documento debe ser "dni" o "licencia", llegó "{pedido.documento}"')
    trabajo = Trabajo(
        documento=pedido.documento,
        caras={
            "frente": _decodificar(pedido.frente_base64, "frente"),
            "dorso": _decodificar(pedido.dorso_base64, "dorso"),
        },
        referencia=pedido.referencia or "sin-referencia",
        callback_url=pedido.callback_url,
        callback_token=pedido.callback_token,
    )
    if not trabajo.callback_url:
        return JSONResponse(await cola.analizar(trabajo))
    cola.encolar(trabajo)
    log.info("aceptado %s · ref=%s · %d en cola", trabajo.documento, trabajo.referencia, cola.pendientes)
    return JSONResponse(
        {
            "aceptado": True,
            "documento": trabajo.documento,
            "referencia": trabajo.referencia,
            "en_cola": cola.pendientes,
        },
        status_code=202,
    )


@app.post("/analizar/{ruta}", dependencies=[Depends(autorizar)])
async def analizar_cara(ruta: str, imagen: Annotated[UploadFile | None, File()] = None) -> JSONResponse:
    if ruta not in documentos.DOCUMENTOS:
        raise HTTPException(404)
    if imagen is None:
        raise HTTPException(400, "falta la imagen: mandala como archivo en el campo 'imagen' (multipart/form-data)")
    datos = await imagen.read()
    if not datos:
        raise HTTPException(400, "el archivo llegó vacío")
    _controlar_tamano(datos, "la imagen")
    return JSONResponse(await cola.ejecutar(documentos.analizar_cara, datos, ruta))


@app.exception_handler(Exception)
async def error_inesperado(request: Request, error: Exception) -> JSONResponse:
    log.exception("error inesperado en %s", request.url.path)
    documento = request.url.path.rsplit("/", 1)[-1].replace("-", "_")
    return JSONResponse(
        documentos.error_de_cara(documento, f"error inesperado analizando la imagen: {error}"), status_code=500
    )
