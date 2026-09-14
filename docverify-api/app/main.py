"""
LA API DE VERIFICACIÓN DOCUMENTAL.

Un endpoint por cara de documento:

    POST /analizar/dni-frente        OCR + PDF417
    POST /analizar/dni-dorso         OCR + MRZ
    POST /analizar/licencia-frente   OCR
    POST /analizar/licencia-dorso    OCR + PDF417 + código 1D

Los cuatro reciben UNA imagen —como archivo en multipart o en base64 dentro de
un JSON— y devuelven el mismo sobre (ver contrato.py).

ESTE SERVICIO NO ESTÁ CONECTADO CON EL BACKEND. No tiene base de datos, no
guarda las imágenes, no sabe quién es el usuario y no le pega a ninguna otra
API: recibe una foto, la analiza y contesta. Se deploya por su cuenta, y quien
lo quiera usar decide qué hacer con lo que devuelve.
"""

from __future__ import annotations

import base64
import binascii
import logging

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import contrato
from .config import ajustes
from .documentos import REGISTRO
from .documentos import base as analizador_base

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s · %(message)s",
)
log = logging.getLogger("docverify")

app = FastAPI(
    title="FreeWheel · API de verificación documental",
    description=(
        "Extrae los datos del DNI y de la licencia nacional de conducir "
        "argentinos: encuadra el documento, lo endereza y lee su contenido por "
        "todos los medios disponibles (OCR posicional, PDF417, MRZ, códigos 1D "
        "y QR). Un endpoint por cara; el mismo JSON en todos."
    ),
    version=contrato.VERSION_CONTRATO,
)

# El demo es un HTML suelto servido por otro origen (o abierto como archivo),
# así que sin CORS el navegador no puede llamar a esta API. Por defecto se
# permite cualquier origen porque el servicio no tiene sesión ni cookies que
# proteger: lo único que recibe es la imagen que le mandan en el request. Para
# cerrarlo en un deploy real está DOCVERIFY_ORIGENES.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ajustes.origenes_permitidos,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


class ImagenBase64(BaseModel):
    """El cuerpo JSON alternativo al multipart."""

    imagen_base64: str = Field(
        ...,
        description=(
            "La imagen en base64. Se acepta con o sin el prefijo data: "
            "(data:image/jpeg;base64,...)"
        ),
    )


def autorizar(authorization: str | None = Header(default=None)) -> None:
    """
    Comprueba el token compartido, si hay uno configurado.

    Sin DOCVERIFY_TOKEN la API queda abierta, que es lo que se quiere en local.
    En un deploy expuesto a internet conviene ponerlo: por acá pasan documentos
    de identidad de personas reales, y sin token alcanza con conocer la URL.
    """
    esperado = ajustes.token
    if not esperado:
        return
    if authorization != f"Bearer {esperado}":
        raise HTTPException(status_code=401, detail="token inválido o ausente")


@app.get("/health")
def salud() -> dict:
    """
    Si el servicio está vivo y con qué cuenta.

    Incluye si los motores están CARGADOS, que no es lo mismo que instalados:
    el de OCR levanta tres modelos ONNX la primera vez que se lo usa, así que
    el primer análisis después de arrancar tarda varios segundos más que el
    resto. Saberlo evita diagnosticar como "la API está lenta" lo que es el
    arranque en frío.
    """
    from . import ocr

    return {
        "ok": True,
        "servicio": "docverify-api",
        "version": contrato.VERSION_CONTRATO,
        "documentos": sorted(REGISTRO),
        "ocr_cargado": ocr._motor is not None,
        "protegido_con_token": bool(ajustes.token),
    }


@app.get("/contrato")
def describir_contrato() -> dict:
    """
    Qué devuelve cada endpoint: los orígenes de cada documento y el diccionario
    completo de campos. Es la forma de saber qué esperar sin tener que mandar
    una foto para averiguarlo.
    """
    documentos = {}
    for ruta, analizador in sorted(REGISTRO.items()):
        origenes = {}
        for atributo, nombre in (
            ("CAMPOS_OCR", "ocr"),
            ("CAMPOS_CODIGO", "pdf417"),
            ("CAMPOS_MRZ", "mrz"),
            ("CAMPOS_1D", "codigo_1d"),
        ):
            campos = getattr(analizador, atributo, None)
            if campos:
                origenes[nombre] = list(campos)
        documentos[ruta] = {
            "clave": analizador.CLAVE,
            "formatos_de_codigo": list(analizador.FORMATOS_CODIGO),
            "campos_por_origen": origenes,
        }

    return {
        "version": contrato.VERSION_CONTRATO,
        "diccionario": contrato.DICCIONARIO,
        "documentos": documentos,
    }


async def _bytes_del_request(
    request: Request, imagen: UploadFile | None
) -> bytes:
    """
    Los bytes de la imagen, venga como archivo o como base64.

    Se soportan las dos formas porque los dos clientes son muy distintos: un
    <input type=file> del navegador manda multipart naturalmente, y un backend
    que ya tiene la imagen en memoria manda JSON sin tener que armar un
    multipart a mano.
    """
    if imagen is not None:
        datos = await imagen.read()
        if not datos:
            raise HTTPException(status_code=400, detail="el archivo llegó vacío")
        return datos

    cuerpo = await request.body()
    if not cuerpo:
        raise HTTPException(
            status_code=400,
            detail=(
                "falta la imagen: mandala como archivo en el campo 'imagen' "
                "(multipart/form-data) o en 'imagen_base64' (JSON)"
            ),
        )

    try:
        datos_json = ImagenBase64.model_validate_json(cuerpo)
    except Exception as error:  # noqa: BLE001 - se traduce a un 400 explicado
        raise HTTPException(
            status_code=400,
            detail=(
                "el cuerpo no es ni un multipart con el campo 'imagen' ni un "
                f"JSON con 'imagen_base64' ({error})"
            ),
        ) from error

    crudo = datos_json.imagen_base64.strip()
    # Se tolera el data URI completo: es lo que devuelve un FileReader del
    # navegador, y obligar a recortarlo del lado del cliente solo agrega un
    # paso donde equivocarse.
    if crudo.startswith("data:"):
        _, _, crudo = crudo.partition(",")

    try:
        return base64.b64decode(crudo, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(
            status_code=400, detail=f"el base64 no es válido: {error}"
        ) from error


def _registrar_endpoint(ruta: str, analizador) -> None:
    """
    Publica el endpoint de un documento.

    Se generan en un bucle a partir del REGISTRO y no a mano uno por uno para
    que no puedan divergir: los cuatro tienen que recibir lo mismo y devolver
    lo mismo, y escribirlos cuatro veces es la forma de que con el tiempo dejen
    de hacerlo.
    """

    async def endpoint(
        request: Request,
        imagen: UploadFile | None = File(
            default=None, description="La foto del documento (jpg, png o webp)"
        ),
        _: None = Depends(autorizar),
    ) -> JSONResponse:
        datos = await _bytes_del_request(request, imagen)

        if len(datos) > ajustes.max_bytes:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"la imagen pesa {len(datos) // 1024} KB y el máximo es "
                    f"{ajustes.max_bytes // 1024} KB"
                ),
            )

        log.info("analizando %s (%d KB)", analizador.CLAVE, len(datos) // 1024)
        resultado = analizador_base.analizar(datos, analizador)
        log.info(
            "%s listo en %d ms · ok=%s · encuadre=%s rot=%s",
            analizador.CLAVE,
            resultado.get("ms", 0),
            resultado.get("ok"),
            resultado.get("encuadre", {}).get("metodo"),
            resultado.get("encuadre", {}).get("rotacion"),
        )
        # 200 aunque no se haya podido leer nada: que una foto salga movida no
        # es un error del pedido. El resultado va en `ok` y el motivo, por
        # origen, en su `error`.
        return JSONResponse(content=resultado)

    endpoint.__name__ = f"analizar_{analizador.CLAVE}"
    app.post(
        f"/analizar/{ruta}",
        summary=f"Analizar {ruta.replace('-', ' ')}",
        description=(analizador.__doc__ or "").strip().split("\n\n")[0],
        tags=["análisis"],
    )(endpoint)


for _ruta, _analizador in REGISTRO.items():
    _registrar_endpoint(_ruta, _analizador)


@app.exception_handler(Exception)
async def error_inesperado(request: Request, error: Exception) -> JSONResponse:
    """
    Un fallo no previsto se devuelve con la forma del contrato, no como un 500
    pelado: el cliente ya sabe leer esta forma y así el motivo le llega igual.
    """
    log.exception("error inesperado en %s", request.url.path)
    documento = request.url.path.rsplit("/", 1)[-1].replace("-", "_")
    return JSONResponse(
        status_code=500,
        content=contrato.error_de_analisis(
            documento, f"error inesperado analizando la imagen: {error}"
        ),
    )
