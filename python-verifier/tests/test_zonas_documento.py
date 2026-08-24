from zonas_documento import ZONA_MRZ_DNI_DORSO, ZONAS, zona_a_pixeles


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
