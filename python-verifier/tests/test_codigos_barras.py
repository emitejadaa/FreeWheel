from codigos_barras import parsear_pdf417_dni


PAYLOAD = "00123456789@PEREZ@JUAN CARLOS@M@20123456@A@01/02/1990@05/03/2015"


def test_parsea_el_pdf417_del_renaper():
    resultado = parsear_pdf417_dni(PAYLOAD)
    assert resultado["ok"]
    assert resultado["datos"] == {
        "apellido": "PEREZ",
        "nombre": "JUAN CARLOS",
        "sexo": "M",
        "nDocumento": "20123456",
        "fechaNacimiento": "1990-02-01",
        "fechaEmision": "2015-03-05",
    }


def test_rechaza_un_codigo_sin_arrobas():
    resultado = parsear_pdf417_dni("https://validar.licencia.gob.ar/x123")
    assert not resultado["ok"]
    assert resultado["error"]["code"] == "CODIGO_NO_ES_DNI"


def test_rechaza_un_codigo_incompleto():
    resultado = parsear_pdf417_dni("123@PEREZ@JUAN")
    assert not resultado["ok"]
    assert resultado["error"]["code"] == "CODIGO_INCOMPLETO"


def test_rechaza_un_documento_que_no_es_dni():
    payload = "00123456789@PEREZ@JUAN@M@ABC@A@01/02/1990@05/03/2015"
    resultado = parsear_pdf417_dni(payload)
    assert not resultado["ok"]
    assert resultado["error"]["code"] == "CODIGO_SIN_DOCUMENTO"


def test_tolera_campos_extra_al_final():
    resultado = parsear_pdf417_dni(PAYLOAD + "@extra@otro")
    assert resultado["ok"]
    assert resultado["datos"]["nDocumento"] == "20123456"
