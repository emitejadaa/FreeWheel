"""
LA API DE VERIFICACIÓN DOCUMENTAL.

DOS FORMAS DE USARLA, para dos usos que no se parecen.

**Un documento entero, en segundo plano** — es la que usa el backend:

    POST /analizar/documento    las dos caras juntas, 202 y aviso al terminar

Manda frente y dorso en un JSON, contesta 202 en el acto y, cuando terminó,
le pega de vuelta a la URL que le dejaron. Es así porque un documento son dos
análisis de varios segundos cada uno y porque en una instancia chica no pueden
correr dos a la vez: la espera no entra en un request HTTP. Además es el único
modo que puede cruzar una cara contra la otra, que es de donde sale casi todo
el valor —el apellido del frente del DNI contra el de la MRZ del dorso, el
número de licencia del frente contra el del PDF417 del dorso.

**Una cara suelta, al toque** — para mirar una foto y ver qué se leyó:

    POST /analizar/dni-frente        OCR + PDF417
    POST /analizar/dni-dorso         OCR + MRZ
    POST /analizar/licencia-frente   OCR
    POST /analizar/licencia-dorso    OCR + PDF417 + código 1D

Reciben UNA imagen —archivo multipart o base64 en un JSON— y devuelven el sobre
de esa cara (ver contrato.py).

ESTE SERVICIO NO SABE NADA DE NADIE. No tiene base de datos, no guarda las
imágenes, no sabe quién es el usuario y no decide si una verificación se aprueba.
Recibe fotos, dice qué leyó en cada una y con cuánta confianza, y avisa si las
distintas lecturas de un mismo dato coinciden entre sí. QUIÉN ES ESA PERSONA Y
SI CORRESPONDE A LA CUENTA LO DECIDE EL BACKEND, que es el único lado que
conoce al usuario.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import contrato, trabajos
from .config import ajustes
from .documentos import REGISTRO
from .documentos import base as analizador_base

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s · %(message)s",
)
log = logging.getLogger("docverify")

@asynccontextmanager
async def ciclo_de_vida(_app: FastAPI):
    """
    Prende el motor de OCR apenas arranca el servicio, sin bloquear el arranque.

    Abrir las tres sesiones de ONNX Runtime y reservarles memoria son varios
    segundos en una instancia con poca CPU. Sin esto los pagaba el PRIMER
    documento que llegara, que es el peor momento posible: justo después de un
    arranque en frío, que es cuando el servicio ya viene demorado.

    Va en un hilo y sin esperar el resultado a propósito. Si bloqueara el
    arranque, el health check no contestaría hasta que el motor estuviera
    listo, y la plataforma podría dar el deploy por fallido. Así el servicio
    responde enseguida y se calienta solo por atrás; y si igual llega un
    documento mientras tanto, `ocr.motor()` está bajo candado y simplemente
    espera a que termine de cargar, sin abrir un segundo motor.
    """
    from . import ocr

    tarea = asyncio.create_task(asyncio.to_thread(ocr.motor))
    tarea.add_done_callback(
        lambda t: log.info("motor de OCR listo")
        if not t.cancelled() and t.exception() is None
        # No se relanza: un motor que no carga acá va a volver a intentarlo —y
        # a fallar con su propio error— en el primer análisis. Tumbar el
        # servicio entero dejaría también sin `/health` a quien lo diagnostica.
        else log.error("el motor de OCR no cargó al arrancar: %s", t.exception())
    )
    yield


app = FastAPI(
    lifespan=ciclo_de_vida,
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


class PedidoDocumento(BaseModel):
    """Las dos caras de un documento y a dónde avisar cuando esté listo."""

    documento: str = Field(..., description='"dni" o "licencia"')
    frente_base64: str = Field(..., description="La foto del frente, en base64")
    dorso_base64: str = Field(..., description="La foto del dorso, en base64")
    referencia: str = Field(
        default="",
        description=(
            "Identificador de quien pide el análisis. Vuelve tal cual en el "
            "aviso; esta API no lo interpreta, solo lo repite para que los logs "
            "de los dos lados se puedan cruzar"
        ),
    )
    callback_url: str = Field(
        default="",
        description=(
            "A dónde mandar el resultado cuando termine. SI SE OMITE, el "
            "análisis se hace esperando y el resultado viene en esta misma "
            "respuesta: sirve para probar a mano, pero puede tardar bastante "
            "más de lo que aguanta un cliente HTTP común"
        ),
    )
    callback_token: str = Field(
        default="",
        description=(
            "Se manda como `Authorization: Bearer` al avisar, para que quien "
            "recibe el aviso pueda comprobar que corresponde a un pedido suyo"
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

    `ocr_cargado` dice si el motor de OCR ya está abierto EN ESTE PROCESO, que
    no es lo mismo que si los modelos están instalados —lo están siempre: vienen
    dentro del paquete `rapidocr`—. Al arrancar se dispara la carga en segundo
    plano, así que este campo pasa de false a true solo, en unos segundos, sin
    que nadie mande una foto. Verlo en false justo después de un deploy es
    normal; verlo en false minutos después significa que la carga falló, y el
    motivo está en los logs.
    """
    from . import ocr

    return {
        "ok": True,
        "servicio": "docverify-api",
        "version": contrato.VERSION_CONTRATO,
        "documentos": sorted(REGISTRO),
        "ocr_cargado": ocr._motor is not None,
        "protegido_con_token": bool(ajustes.token),
        # Cuántos análisis hay aceptados y sin terminar. Es lo primero que hay
        # que mirar cuando "la API está lenta": si acá hay número, no está
        # lenta, está ocupada, y el que pidió último espera a los de adelante.
        "analisis_en_cola": trabajos.pendientes(),
        "analisis_simultaneos": ajustes.concurrencia,
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


def _bytes_de_base64(crudo: str, cual: str) -> bytes:
    """Los bytes de una imagen que vino en base64, con el data URI tolerado."""
    limpio = (crudo or "").strip()
    if not limpio:
        raise HTTPException(status_code=400, detail=f"falta la imagen del {cual}")
    # Es lo que devuelve un FileReader del navegador. Obligar a recortarlo del
    # lado del cliente solo agrega un paso donde equivocarse.
    if limpio.startswith("data:"):
        _, _, limpio = limpio.partition(",")
    try:
        datos = base64.b64decode(limpio, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(
            status_code=400,
            detail=f"el base64 del {cual} no es válido: {error}",
        ) from error
    if not datos:
        raise HTTPException(status_code=400, detail=f"la imagen del {cual} llegó vacía")
    if len(datos) > ajustes.max_bytes:
        raise HTTPException(
            status_code=413,
            detail=(
                f"la imagen del {cual} pesa {len(datos) // 1024} KB y el máximo "
                f"es {ajustes.max_bytes // 1024} KB"
            ),
        )
    return datos


@app.post(
    "/analizar/documento",
    summary="Analizar un documento entero (las dos caras)",
    tags=["análisis"],
)
async def analizar_documento(
    pedido: PedidoDocumento, _: None = Depends(autorizar)
) -> JSONResponse:
    """
    Las dos caras de un documento, con los cruces entre ellas.

    Contesta **202 y avisa después** cuando le dejan un `callback_url`, que es
    como lo usa el backend. Sin `callback_url` analiza esperando y devuelve el
    resultado en esta misma respuesta: sirve para probar a mano con curl, pero
    puede tardar más de lo que aguanta un cliente HTTP común.
    """
    if pedido.documento not in ("dni", "licencia"):
        raise HTTPException(
            status_code=400,
            detail=f'el documento debe ser "dni" o "licencia", llegó "{pedido.documento}"',
        )

    trabajo = trabajos.Pedido(
        documento=pedido.documento,
        caras={
            "frente": _bytes_de_base64(pedido.frente_base64, "frente"),
            "dorso": _bytes_de_base64(pedido.dorso_base64, "dorso"),
        },
        referencia=pedido.referencia or "sin-referencia",
        callback_url=pedido.callback_url,
        callback_token=pedido.callback_token,
    )

    if not trabajo.callback_url:
        return JSONResponse(content=await trabajos.analizar_esperando(trabajo))

    try:
        await trabajos.encolar(trabajo)
    except trabajos.ColaLlena as llena:
        # 503 y no 500: no es un error, es que ahora no se puede. Con
        # Retry-After para que quien llama sepa cuánto esperar en vez de
        # reintentar en loop.
        raise HTTPException(
            status_code=503,
            detail=f"la API está saturada: {llena}. Reintentá en un rato.",
            headers={"Retry-After": "60"},
        ) from llena

    log.info(
        "aceptado %s · ref=%s · %d en cola",
        trabajo.documento,
        trabajo.referencia,
        trabajos.pendientes(),
    )
    return JSONResponse(
        status_code=202,
        content={
            "aceptado": True,
            "documento": trabajo.documento,
            "referencia": trabajo.referencia,
            "en_cola": trabajos.pendientes(),
        },
    )


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
