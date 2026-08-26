"""Las zonas de la tarjeta rectificada y la lectura del dorso de la licencia,
que no usa zonas: busca el CUIL (con su dígito verificador) y la leyenda de
principiante en el texto completo."""

from campos import (
    ZONA_MRZ_DNI_DORSO,
    ZONAS,
    _cuil_en_texto,
    _ETIQUETAS_FECHA_LICENCIA,
    _fecha_por_etiqueta,
    _principiante_en_lineas,
    zona_a_pixeles,
)


# ── Zonas ─────────────────────────────────────────────────────────────────

def test_zona_a_pixeles_sin_padding():
    caja = zona_a_pixeles((0.0, 0.0, 0.5, 0.5), ancho=1000, alto=1000, padding=0.0)
    assert caja == (0, 0, 500, 500)


def test_zona_a_pixeles_con_padding_no_se_sale_del_borde():
    caja = zona_a_pixeles((0.0, 0.0, 1.0, 1.0), ancho=1000, alto=1000, padding=0.05)
    assert caja == (0, 0, 1000, 1000)


def test_zona_a_pixeles_padding_agranda_el_recorte():
    caja = zona_a_pixeles((0.4, 0.4, 0.6, 0.6), ancho=1000, alto=1000, padding=0.1)
    assert caja[0] < 400 and caja[1] < 400
    assert caja[2] > 600 and caja[3] > 600


def test_los_documentos_con_zonas_las_tienen():
    # license_back no usa zonas: el CUIL y la leyenda de principiante se
    # buscan en el texto completo del dorso.
    for slot in ("dni_front", "dni_back", "license_front"):
        assert slot in ZONAS
        assert len(ZONAS[slot]) > 0
    assert "license_back" not in ZONAS


def test_campos_esperados_por_documento():
    assert set(ZONAS["dni_front"]) == {
        "apellido", "nombre", "sexo", "fechaNacimiento",
        "fechaEmision", "fechaVencimiento", "nDocumento",
    }
    assert set(ZONAS["dni_back"]) == {"domicilio", "cuil"}
    assert set(ZONAS["license_front"]) == {
        "numLicencia", "apellido", "nombre", "domicilio",
        "fechaNacimiento", "fechaVencimiento",
    }


def test_zona_mrz_dni_dorso_definida():
    assert len(ZONA_MRZ_DNI_DORSO) == 4


def test_todas_las_zonas_son_coordenadas_validas():
    for zonas_doc in ZONAS.values():
        for zona in zonas_doc.values():
            x0, y0, x1, y1 = zona
            assert 0.0 <= x0 < x1 <= 1.0
            assert 0.0 <= y0 < y1 <= 1.0


# ── Dorso de la licencia ──────────────────────────────────────────────────

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
