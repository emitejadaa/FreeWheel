"""Las dos formas en que el server se niega a arrancar.

Las dos terminan en `return 1` con un motivo entendible en stderr, y no en un
traceback: son justo los casos que aparecen probando en local.
"""

import socket

import server


def test_sin_token_no_arranca(monkeypatch, capsys):
    monkeypatch.delenv("DOCVERIFY_TOKEN", raising=False)
    monkeypatch.delenv("DOCVERIFY_ALLOW_ANONYMOUS", raising=False)

    assert server.main() == 1
    salida = capsys.readouterr().err
    assert "DOCVERIFY_TOKEN" in salida
    # Recibe documentos de identidad: abierto a cualquiera no va.
    assert "DOCVERIFY_ALLOW_ANONYMOUS" in salida


def test_con_el_puerto_ocupado_avisa_en_vez_de_explotar(monkeypatch, capsys):
    ocupante = socket.socket()
    ocupante.bind(("127.0.0.1", 0))
    ocupante.listen(1)
    puerto = ocupante.getsockname()[1]
    try:
        monkeypatch.setenv("DOCVERIFY_ALLOW_ANONYMOUS", "true")
        monkeypatch.setenv("PORT", str(puerto))

        assert server.main() == 1
        salida = capsys.readouterr().err
        assert str(puerto) in salida
        assert "ocupado" in salida
    finally:
        ocupante.close()
