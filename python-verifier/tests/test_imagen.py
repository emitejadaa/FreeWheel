from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from imagen import encontrar_contorno_documento, rectificar_documento

TEST_DOCS = Path(__file__).resolve().parent.parent / "testDocuments"


def _foto_sintetica_con_rectangulo():
    """Un rectángulo blanco en perspectiva sobre fondo oscuro, como una
    tarjeta fotografiada de costado y no de frente."""
    imagen = Image.new("RGB", (800, 600), (30, 30, 30))
    dibujo = ImageDraw.Draw(imagen)
    dibujo.polygon([(150, 120), (650, 180), (600, 480), (100, 420)], fill=(255, 255, 255))
    return imagen


def test_encuentra_contorno_en_foto_sintetica():
    contorno = encontrar_contorno_documento(_foto_sintetica_con_rectangulo())
    assert contorno is not None
    assert contorno.shape == (4, 2)


def test_no_encuentra_contorno_en_foto_sin_documento():
    imagen = Image.new("RGB", (800, 600), (30, 30, 30))
    assert encontrar_contorno_documento(imagen) is None


@pytest.mark.skipif(
    not TEST_DOCS.is_dir(),
    reason="testDocuments/ no está: son documentos reales y no se versionan",
)
@pytest.mark.parametrize(
    "archivo",
    ["dniFrente.jpeg", "dniDorso.jpeg", "licenciaFrente.jpeg", "licenciaDorso.jpeg"],
)
def test_rectifica_documentos_reales(archivo):
    imagen = Image.open(TEST_DOCS / archivo)
    resultado = rectificar_documento(imagen)
    assert resultado["ok"] is True, resultado.get("error")
    rectificada = resultado["imagen"]
    assert rectificada.width > 0 and rectificada.height > 0
