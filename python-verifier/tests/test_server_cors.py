"""CORS: lo que decide si el front demo local puede hablarle al verificador.

Apagado por defecto —en el deploy el único que llama es el backend, servidor
contra servidor— y prendido a mano con DOCVERIFY_CORS_ORIGIN. Que un cambio no
lo deje abierto sin querer, ni roto para probar en local.
"""

import http.client
import threading
from http.server import ThreadingHTTPServer

import pytest

import server


@pytest.fixture
def verificador(monkeypatch):
    """Levanta el server en un puerto libre con el CORS que pida el test."""
    servidores: list[ThreadingHTTPServer] = []

    def fabrica(origenes: str | None = None):
        if origenes is None:
            monkeypatch.delenv("DOCVERIFY_CORS_ORIGIN", raising=False)
        else:
            monkeypatch.setenv("DOCVERIFY_CORS_ORIGIN", origenes)
        # Sin token: lo que se prueba acá es el CORS, no la autorización.
        monkeypatch.delenv("DOCVERIFY_TOKEN", raising=False)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        servidores.append(httpd)
        return httpd.server_address[1]

    yield fabrica

    for httpd in servidores:
        httpd.shutdown()
        httpd.server_close()


def pedir(puerto: int, metodo: str, ruta: str, origen: str | None = None):
    conexion = http.client.HTTPConnection("127.0.0.1", puerto, timeout=10)
    try:
        conexion.request(metodo, ruta, headers={"Origin": origen} if origen else {})
        respuesta = conexion.getresponse()
        respuesta.read()
        return respuesta.status, dict(respuesta.getheaders())
    finally:
        conexion.close()


def test_sin_configurar_no_manda_cabeceras_de_cors(verificador):
    puerto = verificador(None)

    _, cabeceras = pedir(puerto, "GET", "/health", origen="https://cualquiera.example")
    assert "Access-Control-Allow-Origin" not in cabeceras

    estado, cabeceras = pedir(puerto, "OPTIONS", "/analyze", origen="https://cualquiera.example")
    assert estado == 204  # el preflight contesta, pero sin permiso
    assert "Access-Control-Allow-Origin" not in cabeceras


def test_con_asterisco_contesta_el_origen_que_pregunto(verificador):
    puerto = verificador("*")

    # "null" es el origen de un archivo abierto con file://, que es como se
    # abre el front demo: tiene que funcionar igual.
    for origen in ("http://localhost:5500", "null"):
        estado, cabeceras = pedir(puerto, "OPTIONS", "/analyze", origen=origen)
        assert estado == 204
        assert cabeceras["Access-Control-Allow-Origin"] == origen
        assert cabeceras["Vary"] == "Origin"
        assert "POST" in cabeceras["Access-Control-Allow-Methods"]
        # Sin esto el navegador no deja mandar el token ni el JSON.
        permitidas = cabeceras["Access-Control-Allow-Headers"].lower()
        assert "authorization" in permitidas and "content-type" in permitidas


def test_con_lista_solo_pasan_los_origenes_listados(verificador):
    puerto = verificador("http://localhost:5500, http://127.0.0.1:5500")

    _, cabeceras = pedir(puerto, "OPTIONS", "/analyze", origen="http://localhost:5500")
    assert cabeceras["Access-Control-Allow-Origin"] == "http://localhost:5500"

    _, cabeceras = pedir(puerto, "OPTIONS", "/analyze", origen="https://otra.example")
    assert "Access-Control-Allow-Origin" not in cabeceras


def test_el_preflight_de_una_ruta_que_no_existe_es_404(verificador):
    puerto = verificador("*")
    estado, _ = pedir(puerto, "OPTIONS", "/otra-cosa", origen="null")
    assert estado == 404


def test_las_respuestas_de_error_tambien_llevan_cors(verificador):
    # Si el error viaja sin cabeceras, el navegador lo tapa con "CORS error"
    # y el motivo real (401, 413, slot desconocido) no se ve en ningún lado.
    puerto = verificador("*")
    estado, cabeceras = pedir(puerto, "GET", "/no-existe", origen="null")
    assert estado == 404
    assert cabeceras["Access-Control-Allow-Origin"] == "null"
