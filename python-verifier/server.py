#!/usr/bin/env python3
"""
VERIFICADOR DE DOCUMENTOS — servidor HTTP
=========================================

El mismo análisis que analyze.py, pero por HTTP en vez de por stdin/stdout.

POR QUÉ EXISTE
--------------
El backend de FreeWheel corre en Vercel serverless, donde NO hay Python ni el
binario de tesseract y no los puede haber: son dependencias del sistema
operativo, no paquetes de npm. Ahí `analyze.py` como subproceso es imposible, y
sin verificador la revisión automática no corre: todo documento termina
esperando a un administrador.

Así que el verificador se despliega APARTE —una imagen con Python, tesseract y
las librerías (ver Dockerfile)— y el backend le manda las fotos por HTTP. La
respuesta es EXACTAMENTE el mismo JSON que devuelve analyze.py, así que del
lado del backend el resto del flujo no distingue por dónde vino.

CONTRATO
--------
    POST /analyze
    Authorization: Bearer <DOCVERIFY_TOKEN>      (si está configurado)
    {"documentos": {"dni_front": "<base64>", "dni_back": "<base64>"}}

    200 -> el JSON de contrato.py, igual que analyze.py

    GET /health -> {"ok": true, "tesseract": "5.3.4", "version": "1.0"}

    OPTIONS /analyze -> el preflight del navegador (solo con CORS prendido)

Las fotos van en base64 en el cuerpo porque el que llama es otro servicio, sin
disco compartido: no puede pasar una ruta.

SEGURIDAD
---------
Esto recibe documentos de identidad, así que:
  · DOCVERIFY_TOKEN es OBLIGATORIO salvo que se pida explícitamente lo
    contrario con DOCVERIFY_ALLOW_ANONYMOUS=true (solo para probar en local).
    Sin token el servidor se niega a arrancar en vez de quedar abierto.
  · las fotos se escriben en un temporal con permisos 0600 y se borran siempre,
    incluso si el análisis explota;
  · nada se registra en disco ni se loguea el contenido de las imágenes;
  · hay un tope de tamaño por pedido: un cuerpo enorme no puede voltear el
    proceso.

DESDE EL NAVEGADOR (CORS)
-------------------------
Quien llama en el deploy es el backend —servidor contra servidor, sin CORS de
por medio—, así que por defecto NO se manda ninguna cabecera de CORS y un
navegador no puede pegarle. Eso es a propósito: con CORS abierto, cualquier
página que la persona visite podría mandarle documentos a este servidor (o
gastarle el CPU) desde su navegador.

Para probar en local hay un front que le habla directo, sin backend
(public/demo/verificador-python.html). Para que ese front funcione hay que
prender CORS explícitamente:

    DOCVERIFY_CORS_ORIGIN='*'                       # cualquier origen
    DOCVERIFY_CORS_ORIGIN='http://localhost:5500'   # solo ese
    DOCVERIFY_CORS_ORIGIN='null'                    # el archivo abierto con file://

Con '*' el token igual se sigue exigiendo; lo que cambia es solo quién puede
hablarle desde un navegador. En un servidor expuesto: o se deja apagado, o se
listan los orígenes uno por uno.

CÓMO SE CORRE
-------------
    DOCVERIFY_TOKEN=... .venv/bin/python server.py          # puerto 8000
    PORT=9000 DOCVERIFY_TOKEN=... .venv/bin/python server.py

    # local, con el front demo que le habla directo:
    DOCVERIFY_ALLOW_ANONYMOUS=true DOCVERIFY_CORS_ORIGIN='*' .venv/bin/python server.py
"""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from analyze import VERSION, analizar_slot
from contrato import SLOTS

# Tope del cuerpo del pedido. Cuatro fotos de documento con holgura; en base64
# el tamaño crece un tercio, así que 32 MB de cuerpo son ~24 MB de imágenes.
MAX_BODY_BYTES = 32 * 1024 * 1024


def _token() -> str | None:
    return (os.environ.get("DOCVERIFY_TOKEN") or "").strip() or None


def _anonimo_permitido() -> bool:
    return (os.environ.get("DOCVERIFY_ALLOW_ANONYMOUS") or "").lower() == "true"


def _origenes_cors() -> list[str]:
    """Orígenes de navegador habilitados. Lista vacía = CORS apagado, que es
    lo que corresponde cuando el único que llama es el backend."""
    crudo = (os.environ.get("DOCVERIFY_CORS_ORIGIN") or "").strip()
    return [origen.strip() for origen in crudo.split(",") if origen.strip()]


def _version_tesseract() -> str | None:
    """La versión del binario, o None si no está. Es LA dependencia de sistema."""
    try:
        salida = subprocess.run(
            ["tesseract", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        primera = (salida.stdout or salida.stderr).splitlines()
        return primera[0].strip() if primera else None
    except (OSError, subprocess.SubprocessError):
        return None


def analizar_documentos(documentos: dict[str, str]) -> dict:
    """Las fotos en base64 → el JSON de contrato, igual que analyze.py."""
    carpeta = tempfile.mkdtemp(prefix="docverify-")
    try:
        rutas: dict[str, str] = {}
        for slot, contenido in documentos.items():
            ruta = os.path.join(carpeta, f"{slot}.jpg")
            # 0600 desde la creación: el archivo nunca existe siendo legible
            # por otro usuario del sistema.
            fd = os.open(ruta, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as archivo:
                archivo.write(base64.b64decode(contenido, validate=True))
            rutas[slot] = ruta

        salida = {"ok": True, "version": VERSION, "documentos": {}}
        for slot, ruta in rutas.items():
            try:
                salida["documentos"][slot] = analizar_slot(slot, ruta)
            except BaseException as exc:  # noqa: BLE001 - una foto no corta a las demás
                salida["documentos"][slot] = {
                    "error": {
                        "code": "EXCEPCION_INESPERADA",
                        "message": f"{type(exc).__name__}: {exc}",
                    }
                }
        return salida
    finally:
        # Los documentos de identidad no se quedan en el disco de nadie.
        shutil.rmtree(carpeta, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = f"docverify/{VERSION}"

    def log_message(self, formato: str, *args) -> None:  # noqa: A002
        # Al log solo el método, la ruta y el código: nunca el cuerpo.
        sys.stderr.write(f"[docverify] {self.address_string()} {formato % args}\n")

    def _origen_permitido(self) -> str | None:
        """Qué contestar en Access-Control-Allow-Origin, o None si este
        pedido no lleva CORS (apagado, u origen fuera de la lista)."""
        permitidos = _origenes_cors()
        if not permitidos:
            return None
        origen = self.headers.get("Origin")
        if "*" in permitidos:
            # Se devuelve el origen tal cual y no un "*" literal: es lo que
            # necesita un archivo abierto con file:// (manda Origin: null).
            return origen or "*"
        return origen if origen in permitidos else None

    def _cabeceras_cors(self) -> None:
        origen = self._origen_permitido()
        if not origen:
            return
        self.send_header("Access-Control-Allow-Origin", origen)
        # La respuesta depende del origen que la pidió: sin Vary, un proxy
        # cachea la de un origen y se la sirve a otro.
        self.send_header("Vary", "Origin")

    def _responder(self, codigo: int, cuerpo: dict) -> None:
        datos = json.dumps(cuerpo, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self._cabeceras_cors()
        self.end_headers()
        self.wfile.write(datos)

    def _error(self, codigo: int, code: str, message: str) -> None:
        self._responder(codigo, {"ok": False, "error": {"code": code, "message": message}})

    def _autorizado(self) -> bool:
        esperado = _token()
        if not esperado:
            return True
        recibido = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        # compare_digest: comparar con == filtra el token por el tiempo que tarda.
        return hmac.compare_digest(recibido, esperado)

    def do_OPTIONS(self) -> None:  # noqa: N802
        """El preflight que manda el navegador antes de un POST con
        Authorization. El backend habla servidor a servidor y nunca pasa por
        acá: esto existe solo para el front demo local."""
        if self.path.rstrip("/") not in ("/analyze", "/health", ""):
            self._error(404, "NO_ENCONTRADO", f"No existe {self.path}")
            return

        origen = self._origen_permitido()
        if not origen:
            # El navegador solo va a mostrar "CORS error", sin decir por qué.
            # El motivo se escribe acá, que es donde se puede leer.
            sys.stderr.write(
                f"[docverify] preflight rechazado, origen {self.headers.get('Origin')!r}: "
                "prendé CORS con DOCVERIFY_CORS_ORIGIN (ver el docstring).\n"
            )

        self.send_response(204)
        self._cabeceras_cors()
        if origen:
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in ("/health", ""):
            self._error(404, "NO_ENCONTRADO", f"No existe {self.path}")
            return
        tesseract = _version_tesseract()
        self._responder(
            200,
            {
                "ok": tesseract is not None,
                "version": VERSION,
                "tesseract": tesseract,
                "slots": list(SLOTS),
                # Sin el binario de tesseract el OCR no corre: es la falla que
                # más cuesta diagnosticar, así que se dice acá y no en un log.
                "error": None
                if tesseract
                else {
                    "code": "SIN_TESSERACT",
                    "message": "Falta el binario de tesseract con el idioma español.",
                },
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/analyze":
            self._error(404, "NO_ENCONTRADO", f"No existe {self.path}")
            return

        if not self._autorizado():
            self._error(401, "NO_AUTORIZADO", "Falta el token o no es correcto.")
            return

        try:
            largo = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._error(400, "PEDIDO_INVALIDO", "Content-Length inválido.")
            return
        if largo <= 0:
            self._error(400, "PEDIDO_INVALIDO", "El pedido viene vacío.")
            return
        if largo > MAX_BODY_BYTES:
            self._error(
                413,
                "PEDIDO_DEMASIADO_GRANDE",
                f"El pedido supera {MAX_BODY_BYTES // (1024 * 1024)} MB.",
            )
            return

        try:
            pedido = json.loads(self.rfile.read(largo))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            self._error(400, "PEDIDO_INVALIDO", f"El pedido no es JSON: {exc}")
            return

        documentos = pedido.get("documentos") if isinstance(pedido, dict) else None
        if not isinstance(documentos, dict) or not documentos:
            self._error(
                400,
                "PEDIDO_INVALIDO",
                'El pedido debe traer {"documentos": {"<slot>": "<base64>"}}.',
            )
            return

        desconocidos = [slot for slot in documentos if slot not in SLOTS]
        if desconocidos:
            self._error(
                400,
                "SLOT_DESCONOCIDO",
                f"Slots desconocidos: {', '.join(desconocidos)}. Válidos: {', '.join(SLOTS)}.",
            )
            return

        try:
            resultado = analizar_documentos(documentos)
        except (binascii.Error, ValueError) as exc:
            self._error(400, "BASE64_INVALIDO", f"Una de las fotos no es base64 válido: {exc}")
            return
        except BaseException as exc:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            self._error(500, "EXCEPCION_INESPERADA", f"{type(exc).__name__}: {exc}")
            return

        self._responder(200, resultado)


def main() -> int:
    if not _token() and not _anonimo_permitido():
        sys.stderr.write(
            "[docverify] NO ARRANCA: falta DOCVERIFY_TOKEN.\n"
            "  Esto recibe documentos de identidad; abierto a cualquiera no va.\n"
            "  Poné DOCVERIFY_TOKEN=<una clave larga al azar> (la misma que\n"
            "  lleva el backend), o DOCVERIFY_ALLOW_ANONYMOUS=true solo para\n"
            "  probar en tu máquina.\n"
        )
        return 1

    puerto = int(os.environ.get("PORT") or 8000)
    servidor = ThreadingHTTPServer(("0.0.0.0", puerto), Handler)
    tesseract = _version_tesseract()
    origenes = _origenes_cors()
    sys.stderr.write(
        f"[docverify] escuchando en :{puerto} · tesseract: {tesseract or 'NO ESTÁ'}"
        f" · cors: {', '.join(origenes) if origenes else 'apagado'}\n"
    )
    if not tesseract:
        sys.stderr.write(
            "[docverify] AVISO: sin el binario de tesseract el OCR no corre y "
            "todo documento va a fallar. Instalalo (ver requirements.txt).\n"
        )
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
