from normalizadores import (
    limpiar_cuil,
    limpiar_domicilio,
    limpiar_nombre,
    limpiar_sexo,
    limpiar_solo_digitos,
    normalizar_fecha,
)


def test_normalizar_fecha_formato_numerico():
    assert normalizar_fecha("06/04/2009") == "2009-04-06"


def test_normalizar_fecha_formato_mes_abreviado_con_barra():
    assert normalizar_fecha("06 ABR/ APR 2009") == "2009-04-06"


def test_normalizar_fecha_formato_mes_abreviado_sin_barra():
    assert normalizar_fecha("09 AGO 2038") == "2038-08-09"


def test_normalizar_fecha_invalida():
    assert normalizar_fecha("no es una fecha") is None


def test_normalizar_fecha_vacia():
    assert normalizar_fecha(None) is None
    assert normalizar_fecha("") is None


def test_normalizar_fecha_yymmdd_sigue_andando():
    assert normalizar_fecha("090406") == "2009-04-06"


def test_limpiar_nombre_colapsa_espacios():
    assert limpiar_nombre("  TEJADA   ARAGON  ") == "TEJADA ARAGON"


def test_limpiar_nombre_vacio():
    assert limpiar_nombre("") is None
    assert limpiar_nombre(None) is None


def test_limpiar_sexo_valido():
    assert limpiar_sexo("M") == "M"
    assert limpiar_sexo("f") == "F"


def test_limpiar_sexo_invalido():
    assert limpiar_sexo("X") is None
    assert limpiar_sexo("") is None


def test_limpiar_solo_digitos():
    assert limpiar_solo_digitos("49.380.010") == "49380010"


def test_limpiar_solo_digitos_vacio():
    assert limpiar_solo_digitos("sin numeros") is None


def test_limpiar_cuil_valido_con_guiones():
    assert limpiar_cuil("20-49380010-9") == "20-49380010-9"


def test_limpiar_cuil_valido_sin_guiones():
    assert limpiar_cuil("20493800109") == "20-49380010-9"


def test_limpiar_cuil_largo_invalido():
    assert limpiar_cuil("123") is None
    assert limpiar_cuil(None) is None


def test_limpiar_domicilio_colapsa_saltos_de_linea():
    assert limpiar_domicilio("HAITI 2558\n1640 - MARTINEZ") == "HAITI 2558 1640 - MARTINEZ"
