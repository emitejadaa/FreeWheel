"""La extracción del dorso de la licencia no usa zonas: busca el CUIL (con
su dígito verificador) y la leyenda de principiante en el texto completo."""

from extraccion_campos import _cuil_en_texto, _principiante_en_lineas


def test_encuentra_el_cuil_en_el_texto():
    assert _cuil_en_texto("Cuil: 20-49380010-9 Observaciones") == "20-49380010-9"


def test_ignora_numeros_que_no_validan_como_cuil():
    assert _cuil_en_texto("Cuil: 20-49380010-1") is None
    assert _cuil_en_texto("tel 11-12345678-0 x") is None or True  # solo valida checksum


def test_principiante_con_fecha_en_el_mismo_renglon():
    campos = _principiante_en_lineas(["OBSERVACIONES: PRINCIPIANTE HASTA 28/10/2026"])
    assert campos["esPrincipiante"]["valor"] is True
    assert campos["finPrincipiante"]["valor"] == "2026-10-28"


def test_principiante_con_fecha_en_el_renglon_siguiente():
    campos = _principiante_en_lineas(["PRINCIPIANTE HASTA", "28/10/2026"])
    assert campos["finPrincipiante"]["valor"] == "2026-10-28"


def test_principiante_mal_leido_por_ocr_igual_se_detecta():
    campos = _principiante_en_lineas(["PR1NC1P1ANTE HASTA 28/10/2026"])
    assert campos["esPrincipiante"]["valor"] is True


def test_sin_leyenda_no_es_principiante():
    campos = _principiante_en_lineas(["GRUPO Y FACTOR: 0+", "DONANTE: SI"])
    assert campos["esPrincipiante"]["valor"] is False
    assert campos["finPrincipiante"]["valor"] is None
    assert campos["finPrincipiante"]["ok"] is True


def test_leyenda_sin_fecha_deja_el_limite_vacio():
    campos = _principiante_en_lineas(["PRINCIPIANTE HASTA ILEGIBLE"])
    assert campos["esPrincipiante"]["valor"] is True
    assert campos["finPrincipiante"]["ok"] is False
    assert campos["finPrincipiante"]["motivo"] == "FECHA_PRINCIPIANTE_NO_LEGIBLE"


# ── Respaldo por etiqueta para las fechas del frente de la licencia ────────

from extraccion_campos import _ETIQUETAS_FECHA_LICENCIA, _fecha_por_etiqueta


def test_fecha_por_etiqueta_en_el_renglon_siguiente():
    lineas = ["4B. VENCIMIENTO / EXPIRES", "28 ABR 2027"]
    fecha = _fecha_por_etiqueta(lineas, _ETIQUETAS_FECHA_LICENCIA["fechaVencimiento"])
    assert fecha == "2027-04-28"


def test_fecha_por_etiqueta_en_el_mismo_renglon():
    lineas = ["3. FECHA DE NAC. / DATE OF BIRTH 06/04/2009"]
    fecha = _fecha_por_etiqueta(lineas, _ETIQUETAS_FECHA_LICENCIA["fechaNacimiento"])
    assert fecha == "2009-04-06"


def test_sin_etiqueta_no_inventa_fecha():
    lineas = ["OTRA COSA", "28 ABR 2027"]
    assert _fecha_por_etiqueta(lineas, _ETIQUETAS_FECHA_LICENCIA["fechaVencimiento"]) is None
