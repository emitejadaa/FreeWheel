"""Los dos protocolos que se validan solos: el PDF417 del RENAPER y el MRZ
TD1 con sus dígitos verificadores."""

from codigos import (
    buscar_mrz,
    digito_verificador,
    parsear_mrz_td1,
    parsear_pdf417_dni,
)


# ── PDF417 ────────────────────────────────────────────────────────────────

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


# ── MRZ TD1 ───────────────────────────────────────────────────────────────

def _rellenar(texto: str, largo: int = 30) -> str:
    return texto + "<" * (largo - len(texto))


def _lineas_validas() -> list[str]:
    documento = _rellenar("20123456", 9)
    nacimiento, vencimiento = "900201", "350215"
    l1 = _rellenar(f"I<ARG{documento}{digito_verificador(documento)}")
    l2_cabeza = (
        f"{nacimiento}{digito_verificador(nacimiento)}M"
        f"{vencimiento}{digito_verificador(vencimiento)}ARG{'<' * 11}"
    )
    compuesto = l1[5:30] + l2_cabeza[0:7] + l2_cabeza[8:15] + l2_cabeza[18:29]
    l2 = f"{l2_cabeza}{digito_verificador(compuesto)}"
    l3 = _rellenar("PEREZ<<JUAN<CARLOS")
    return [l1, l2, l3]


def test_parsea_un_mrz_valido():
    resultado = parsear_mrz_td1(_lineas_validas())
    assert resultado["ok"]
    assert resultado["todosLosControlesCierran"]
    assert resultado["datos"] == {
        "apellido": "PEREZ",
        "nombre": "JUAN CARLOS",
        "sexo": "M",
        "nDocumento": "20123456",
        "fechaNacimiento": "1990-02-01",
        "fechaVencimiento": "2035-02-15",
    }


def test_un_digito_verificador_que_no_cierra_se_reporta():
    lineas = _lineas_validas()
    lineas[0] = lineas[0][:14] + "0" + lineas[0][15:]
    if lineas[0][14] == _lineas_validas()[0][14]:
        lineas[0] = lineas[0][:14] + "1" + lineas[0][15:]
    resultado = parsear_mrz_td1(lineas)
    assert resultado["ok"]
    assert not resultado["todosLosControlesCierran"]


def test_rechaza_lineas_de_largo_incorrecto():
    lineas = _lineas_validas()
    lineas[1] = lineas[1][:-1]
    resultado = parsear_mrz_td1(lineas)
    assert not resultado["ok"]
    assert resultado["error"]["code"] == "MRZ_LARGO_INCORRECTO"


def test_buscar_mrz_en_texto_con_ruido():
    lineas = _lineas_validas()
    texto = "REPUBLICA ARGENTINA\n" + "\n".join(lineas) + "\nMINISTERIO"
    assert buscar_mrz(texto) == lineas
