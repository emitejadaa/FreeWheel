"""
FRENTE DE LA LICENCIA NACIONAL DE CONDUCIR.

    ┌─────────────────────────────────────────────────┐
    │ ≡ Licencia Nacional de Conducir                 │
    │   Buenos Aires - San Isidro       9. Clases     │
    │ ┌───────┐ 5. N° Licencia / License N°     B.1   │
    │ │       │ 49380010                              │
    │ │ foto  │ 1. Apellido / Last name               │
    │ │       │ TEJADA ARAGON                         │
    │ │       │ 2. Nombre / First name                │
    │ └───────┘ EMILIANO                              │
    │           8. Domicilio / Address                │
    │           3. Fecha de Nac.  7. Firma            │
    │           4a. Otorgamiento  4b. Vencimiento     │
    └─────────────────────────────────────────────────┘

UN SOLO ORIGEN: acá no hay ningún código. El frente de la licencia trae los
datos solo impresos, así que todo depende del OCR y no hay con qué contrastar
lo leído — el contraste, en este documento, se hace contra el dorso, que sí
tiene PDF417.

Lo que sí tiene de particular este frente es que sus campos están NUMERADOS
(el estándar de la licencia nacional: 1 apellido, 2 nombre, 3 nacimiento, 4a
otorgamiento, 4b vencimiento, 5 número, 8 domicilio, 9 clases). Ese número es
un ancla mucho más confiable que el rótulo en sí, porque el rótulo es bilingüe
y largo —"4b. Vencimiento / Expires"— y el OCR lo parte donde se le ocurre,
pero el "4b." al principio del renglón casi siempre sobrevive.
"""

from __future__ import annotations

from .. import codigos as lector_codigos
from .. import encuadre, normalizar, ocr
from ..contrato import Origen, campo
from . import base

CLAVE = "licencia_frente"

ANCLAS = (
    "LICENCIA",
    "CONDUCIR",
    "APELLIDO",
    "NOMBRE",
    "DOMICILIO",
    "VENCIMIENTO",
    "OTORGAMIENTO",
    "CLASES",
    "SEGURIDAD VIAL",
)

# El frente no tiene códigos. Se busca QR igual —hay jurisdicciones que lo
# agregaron— y no cuesta nada hacerlo en la misma pasada.
FORMATOS_CODIGO = ("QRCode",)

# Sin zonas: este lado no tiene códigos. Ver el comentario de _del_qr.
ZONAS_CODIGO: tuple[tuple[float, float, float, float], ...] = ()

CAMPOS_OCR = (
    "numero_licencia",
    "apellido",
    "nombre",
    "domicilio",
    "fecha_nacimiento",
    "fecha_otorgamiento",
    "fecha_vencimiento",
    "clase",
    "jurisdiccion",
)


def extraer(
    lectura: ocr.Lectura,
    codigos: list[lector_codigos.Codigo],
    marco: encuadre.Encuadre,
) -> list[Origen]:
    return [_del_texto(lectura), _del_qr(codigos)]


def _del_texto(lectura: ocr.Lectura) -> Origen:
    origen = Origen(
        nombre="ocr", disponible=True, campos=base.campos_vacios(*CAMPOS_OCR)
    )
    if not lectura:
        origen.error = "no se leyó texto en la imagen"
        return origen

    origen.ok = True

    # TODAS las búsquedas de acá van con validador, y no es un detalle de
    # estilo. Los rótulos de esta licencia son bilingües y de dos partes
    # ("8. Domicilio / Address", "9. Clases / Class"), así que la cola después
    # del rótulo en castellano es el rótulo en inglés: sin validar, el
    # domicilio salía "Address" y la clase salía "C" —la primera letra de
    # "Class"—, los dos con pinta de dato bueno.

    # El número de licencia es el DNI del titular: mismo número, sin puntos.
    numero, conf_numero = lectura.debajo_de(
        "LICENCIA", "LICENSE", validar=normalizar.numero_documento
    )
    if not normalizar.numero_documento(numero):
        numero, conf_numero = lectura.mejor_en_zona(
            (0.24, 0.16, 0.72, 0.33), normalizar.numero_documento
        )
    origen.campos["numero_licencia"] = campo(
        normalizar.numero_documento(numero), numero, conf_numero
    )

    apellido, conf_ape = lectura.debajo_de(
        "APELLIDO", "LAST NAME", validar=_es_nombre
    )
    if not apellido:
        apellido, conf_ape = lectura.mejor_en_zona((0.24, 0.30, 0.78, 0.40), _es_nombre)
    origen.campos["apellido"] = campo(
        normalizar.nombre(apellido), apellido, conf_ape
    )

    nombre, conf_nom = lectura.debajo_de("NOMBRE", "FIRST NAME", validar=_es_nombre)
    if not nombre:
        nombre, conf_nom = lectura.mejor_en_zona((0.24, 0.39, 0.78, 0.49), _es_nombre)
    origen.campos["nombre"] = campo(normalizar.nombre(nombre), nombre, conf_nom)

    # El domicilio ocupa DOS renglones —la calle con sus rótulos internos y,
    # debajo, la localidad— así que se toma la zona entera concatenada en vez
    # de un renglón: quedarse con el primero perdía la localidad.
    domicilio, conf_dom = lectura.texto_en_zona(0.22, 0.50, 0.95, 0.68)
    domicilio = _sin_rotulo(domicilio, "ADDRESS", "DOMICILIO")
    if not _es_domicilio(domicilio):
        domicilio, conf_dom = lectura.despues_de_etiqueta(
            "DOMICILIO", "ADDRESS", validar=_es_domicilio
        )
    origen.campos["domicilio"] = campo(
        normalizar.domicilio(domicilio), domicilio, conf_dom
    )

    # Las tres fechas se buscan por el número del campo (3, 4a, 4b) y, si no
    # aparece, por el rótulo. Una licencia de principiante tiene otorgamiento y
    # vencimiento separados por un año, así que no se pueden distinguir por
    # cuál es mayor: hace falta el rótulo. El vencimiento está en otra columna,
    # abajo a la derecha, y por eso su zona es distinta de las otras dos.
    for nombre_campo, etiquetas, zona in (
        ("fecha_nacimiento", ("3. FECHA", "FECHA DE NAC", "DATE OF BIRTH"),
         (0.20, 0.66, 0.58, 0.80)),
        ("fecha_otorgamiento", ("4A.", "OTORGAMIENTO", "DATE OF ISSUE"),
         (0.20, 0.78, 0.58, 0.93)),
        ("fecha_vencimiento", ("4B.", "VENCIMIENTO", "EXPIRES"),
         (0.55, 0.83, 1.00, 1.00)),
    ):
        crudo, confianza = lectura.despues_de_etiqueta(
            *etiquetas, validar=normalizar.fecha
        )
        if not normalizar.fecha(crudo):
            crudo, confianza = lectura.debajo_de(*etiquetas, validar=normalizar.fecha)
        if not normalizar.fecha(crudo):
            crudo, confianza = lectura.mejor_en_zona(zona, normalizar.fecha)
        origen.campos[nombre_campo] = campo(
            normalizar.fecha(crudo), crudo, confianza
        )

    # La clase va en un recuadro arriba a la derecha, sola. Se busca primero
    # por zona porque ahí no hay nada más que ella; el rótulo queda de
    # respaldo, con validador para que "Class" no se lea como la clase "C".
    clase, conf_clase = lectura.mejor_en_zona(
        (0.72, 0.20, 1.00, 0.42), normalizar.clase_licencia
    )
    if not normalizar.clase_licencia(clase):
        clase, conf_clase = lectura.despues_de_etiqueta(
            "CLASES", "CLASS", validar=normalizar.clase_licencia
        )
    origen.campos["clase"] = campo(
        normalizar.clase_licencia(clase), clase, conf_clase
    )

    # La jurisdicción está debajo del título, con la provincia y el municipio
    # separados por un guion. El validador exige ese guion: es lo que la
    # distingue del título "Licencia Nacional de Conducir", que está pegado
    # arriba y cae en la misma zona.
    jurisdiccion, conf_jur = lectura.mejor_en_zona(
        (0.18, 0.08, 0.95, 0.22), _es_jurisdiccion
    )
    origen.campos["jurisdiccion"] = campo(
        _es_jurisdiccion(jurisdiccion), jurisdiccion, conf_jur
    )

    origen.detalle = {
        "texto_completo": lectura.texto_completo,
        "renglones": len(lectura.renglones),
        "confianza_media": round(lectura.confianza_media, 4),
    }
    return origen


def _sin_rotulo(valor: str, *rotulos: str) -> str:
    """
    Saca el rótulo del principio de un texto tomado por zona.

    Tomar la zona entera es lo único que trae el domicilio completo —son dos
    renglones— pero arrastra el rótulo que está arriba. Se corta después de la
    ÚLTIMA aparición del rótulo, no de la primera, porque es bilingüe y la
    parte en inglés va al final: "8. Domicilio/ Address HAITI…" tiene que
    cortarse en "Address" y no en "Domicilio".
    """
    if not valor:
        return ""
    normalizado = normalizar.sin_tildes(valor).upper()
    corte = 0
    for rotulo in rotulos:
        posicion = normalizado.rfind(normalizar.sin_tildes(rotulo).upper())
        if posicion >= 0:
            corte = max(corte, posicion + len(rotulo))
    return valor[corte:].lstrip(" :./-") if corte else valor


def _es_nombre(valor: str) -> str:
    """
    Un nombre o apellido: al menos tres letras y nada de dígitos.

    Descarta las dos cosas que aparecen donde debería estar el nombre: los
    rótulos con numeración ("2. Nombre / First name") y los caracteres sueltos
    de basura que el motor devuelve sobre las guardas de seguridad.
    """
    limpio = normalizar.nombre(valor)
    if len(limpio.replace(" ", "")) < 3 or any(c.isdigit() for c in valor or ""):
        return ""
    return limpio


def _es_domicilio(valor: str) -> str:
    """
    Un domicilio lleva número: sin un dígito, lo que se leyó es el rótulo.
    Es lo que separa "HAITI, Altura:2558, …" de "Address".
    """
    limpio = normalizar.domicilio(valor)
    if len(limpio) < 6 or not any(c.isdigit() for c in limpio):
        return ""
    return limpio


def _es_jurisdiccion(valor: str) -> str:
    """
    La jurisdicción es "Provincia - Municipio": el guion es obligatorio.

    Sin exigirlo, el título de la tarjeta —"Licencia Nacional de Conducir",
    que está justo arriba y cae en la misma zona— pasaba como jurisdicción.
    """
    limpio = normalizar.texto(valor).upper()
    if "-" not in limpio or len(limpio) < 6:
        return ""
    if "LICENCIA" in normalizar.sin_tildes(limpio):
        return ""
    return limpio


def _del_qr(codigos: list[lector_codigos.Codigo]) -> Origen:
    """
    El frente de la licencia no tiene códigos: disponible=false. Los datos de
    este lado solo se pueden contrastar contra el dorso, que sí trae PDF417.
    """
    origen = Origen(nombre="qr", disponible=False, campos={})
    codigo = lector_codigos.primero(codigos, "QRCode")
    if codigo is not None:
        origen.ok = True
        origen.detalle = {"crudo": codigo.texto, "esquinas": codigo.esquinas}
    else:
        origen.error = "el frente de la licencia no tiene código QR"
    return origen
