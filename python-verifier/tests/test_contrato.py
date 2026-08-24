"""El contrato de salida es lo que consume el backend: si cambia de forma,
que lo diga un test y no un error en producción."""

import contrato
from contrato import CONTRATO, SLOTS, armar_slot, slot_no_procesable

VOCABULARIO = {
    "apellido",
    "nombre",
    "sexo",
    "nDocumento",
    "fechaNacimiento",
    "fechaEmision",
    "fechaVencimiento",
    "domicilio",
    "cuil",
    "numLicencia",
    "esPrincipiante",
    "finPrincipiante",
}


def test_slots_y_protocolos_del_contrato():
    assert SLOTS == ("dni_front", "dni_back", "license_front", "license_back")
    assert set(CONTRATO["dni_front"]) == {"ocr", "codigo"}
    assert set(CONTRATO["dni_back"]) == {"ocr", "mrz"}
    assert set(CONTRATO["license_front"]) == {"ocr"}
    assert set(CONTRATO["license_back"]) == {"ocr"}


def test_todos_los_campos_usan_el_vocabulario_compartido():
    for protocolos in CONTRATO.values():
        for campos in protocolos.values():
            assert set(campos) <= VOCABULARIO


def test_armar_slot_siempre_trae_todos_los_atributos():
    campos = {
        "ocr": {
            "apellido": {"valor": "PEREZ", "ok": True, "confianza": 90.0},
            "nombre": {"valor": None, "ok": False, "motivo": "ZONA_NO_LEGIBLE", "detalle": "x"},
        }
    }
    codigo = {"ok": True, "datos": {"apellido": "PEREZ", "nombre": "JUAN"}}
    resultado = armar_slot("dni_front", campos, codigo)

    assert resultado["ocr"]["title"] == "ocr"
    assert resultado["codigo"]["title"] == "codigo"
    for campo in CONTRATO["dni_front"]["ocr"]:
        assert campo in resultado["ocr"]
    for campo in CONTRATO["dni_front"]["codigo"]:
        assert campo in resultado["codigo"]
    assert resultado["ocr"]["apellido"] == "PEREZ"
    assert resultado["ocr"]["nombre"] is None
    assert resultado["codigo"]["sexo"] is None


def test_fallo_total_de_un_protocolo_sube_como_error():
    campos = {
        "ocr": {
            campo: {"valor": None, "ok": False, "motivo": "SIN_BORDES_DETECTADOS", "detalle": "sin bordes"}
            for campo in CONTRATO["license_front"]["ocr"]
        }
    }
    resultado = armar_slot("license_front", campos, None)
    assert resultado["ocr"]["error"]["code"] == "SIN_BORDES_DETECTADOS"
    assert all(resultado["ocr"][c] is None for c in CONTRATO["license_front"]["ocr"])


def test_codigo_ausente_trae_error_y_campos_null():
    resultado = armar_slot("dni_front", {"ocr": {}}, {"ok": False, "error": {"code": "SIN_CODIGO", "message": "nada"}})
    assert resultado["codigo"]["error"]["code"] == "SIN_CODIGO"
    assert resultado["codigo"]["nDocumento"] is None


def test_principiante_se_funde_en_el_ocr_del_dorso():
    campos = {
        "ocr": {"cuil": {"valor": "20-12345678-6", "ok": True, "confianza": 95.0}},
        "principiante": {
            "esPrincipiante": {"valor": True, "ok": True},
            "finPrincipiante": {"valor": "2027-04-06", "ok": True},
        },
    }
    resultado = armar_slot("license_back", campos, None)
    assert resultado["ocr"]["cuil"] == "20-12345678-6"
    assert resultado["ocr"]["esPrincipiante"] is True
    assert resultado["ocr"]["finPrincipiante"] == "2027-04-06"


def test_slot_no_procesable_conserva_la_forma():
    resultado = slot_no_procesable("dni_back", {"code": "NO_ES_UNA_IMAGEN", "message": "x"})
    assert resultado["error"]["code"] == "NO_ES_UNA_IMAGEN"
    assert set(resultado) == {"ocr", "mrz", "error"}
    for protocolo in ("ocr", "mrz"):
        for campo in CONTRATO["dni_back"][protocolo]:
            assert resultado[protocolo][campo] is None
