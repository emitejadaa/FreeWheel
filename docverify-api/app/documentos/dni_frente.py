"""
FRENTE DEL DNI ARGENTINO (RENAPER, tarjeta Mercosur).

    ┌─────────────────────────────────────────────────┐
    │ REPUBLICA ARGENTINA - MERCOSUR                  │
    │ ┌───────┐  Apellido / Surname                   │
    │ │       │  TEJADA ARAGON                        │
    │ │ foto  │  Nombre / Name                        │
    │ │       │  EMILIANO                             │
    │ │       │  Sexo  Nacionalidad  Ejemplar         │
    │ └───────┘  Fecha de nacimiento                  │
    │            Fecha de emisión                     │
    │ Documento  Fecha de vencimiento    ┌──────────┐ │
    │ 49.380.010 Trámite N°              │  PDF417  │ │
    └─────────────────────────────────────────────────┘

DOS ORÍGENES, y la diferencia entre ellos es el punto de leer los dos:

  · ocr    — lo impreso, incluido el VENCIMIENTO
  · pdf417 — los datos del titular tal como los grabó el RENAPER

El PDF417 NO trae el vencimiento: no está codificado ahí. O sea que el
vencimiento solo existe como texto impreso y no se puede contrastar contra
nada. Al revés, todo lo que sí está en los dos —apellido, nombre, sexo,
documento, nacimiento— se puede cruzar, y una discrepancia entre el texto y el
código es exactamente la señal de una tarjeta alterada.

De la tarjeta se lee SOLO lo que el backend usa para decidir. La nacionalidad,
el ejemplar, el número de trámite y la oficina identificadora están impresos
ahí y se leían bien, pero no se cruzan contra nada ni habilitan nada: leerlos
era gastar zonas de OCR para llenar un JSON que nadie miraba. El ejemplar
además era activamente contraproducente —cambia con cada reimpresión y puede
diferir entre el texto y el código legítimamente—, así que aparecía como una
discrepancia que no lo era.
"""

from __future__ import annotations

from .. import codigos as lector_codigos
from .. import encuadre, normalizar, ocr, pdf417
from ..contrato import Origen, campo
from . import base

CLAVE = "dni_frente"

# Palabras que el frente del DNI tiene siempre impresas, en los dos idiomas
# de la tarjeta. Deciden si la foto está derecha o cabeza abajo.
ANCLAS = (
    "REPUBLICA ARGENTINA",
    "MERCOSUR",
    "APELLIDO",
    "SURNAME",
    "NOMBRE",
    "SEXO",
    "NACIONALIDAD",
    "EJEMPLAR",
    "DOCUMENTO",
    "TRAMITE",
    "VENCIMIENTO",
)

FORMATOS_CODIGO = ("PDF417", "QRCode")

# El PDF417 va abajo a la derecha, al lado del número de documento. La zona se
# declara holgada a propósito: recortar justo le saca al decodificador el
# margen tranquilo que necesita para encontrar el código, y un poco de sobra
# no le molesta.
ZONAS_CODIGO = ((0.48, 0.68, 0.95, 1.0),)

CAMPOS_OCR = (
    "apellido",
    "nombre",
    "sexo",
    "numero_documento",
    "fecha_nacimiento",
    "fecha_vencimiento",
)

# El código no codifica el vencimiento: de los seis de arriba trae cinco, y
# esos cinco son los que se pueden cruzar contra el texto impreso.
CAMPOS_CODIGO = (
    "apellido",
    "nombre",
    "sexo",
    "numero_documento",
    "fecha_nacimiento",
)


def extraer(
    lectura: ocr.Lectura,
    codigos: list[lector_codigos.Codigo],
    marco: encuadre.Encuadre,
) -> list[Origen]:
    return [_del_texto(lectura), _del_codigo(codigos)]


def _del_texto(lectura: ocr.Lectura) -> Origen:
    """
    Los campos impresos.

    Cada uno se busca primero por su ETIQUETA ("el renglón debajo de
    'Apellido'") y, si eso no da nada, por su ZONA (un rectángulo fijo sobre la
    tarjeta encuadrada). La etiqueta aguanta que el recorte esté corrido; la
    zona rescata el caso en que el OCR no leyó el rótulo pero sí el valor.
    """
    origen = Origen(
        nombre="ocr", disponible=True, campos=base.campos_vacios(*CAMPOS_OCR)
    )
    if not lectura:
        origen.error = "no se leyó texto en la imagen"
        return origen

    origen.ok = True

    apellido, confianza = lectura.debajo_de("APELLIDO", "SURNAME")
    if not apellido:
        apellido, confianza = lectura.texto_en_zona(0.37, 0.15, 0.85, 0.28)
    origen.campos["apellido"] = campo(
        normalizar.nombre(apellido), apellido, confianza
    )

    nombre, confianza = lectura.debajo_de("NOMBRE", "NAME")
    if not nombre:
        nombre, confianza = lectura.texto_en_zona(0.37, 0.30, 0.85, 0.42)
    origen.campos["nombre"] = campo(normalizar.nombre(nombre), nombre, confianza)

    # El sexo comparte un renglón de tres columnas con la nacionalidad y el
    # ejemplar, que ya no se leen. Va por zona y no por `debajo_de` porque ese
    # alinea por el borde izquierdo y las tres columnas caen a la misma altura:
    # la zona es lo único que las separa. Y va por `mejor_en_zona` porque la
    # zona agarra también el rótulo de arriba: el validador es el que lo
    # descarta y se queda con el valor.
    sexo, conf_sexo = lectura.mejor_en_zona((0.26, 0.43, 0.40, 0.56), normalizar.sexo)
    origen.campos["sexo"] = campo(normalizar.sexo(sexo), sexo, conf_sexo)

    # Nacimiento y vencimiento tienen su rótulo, y entre los dos está el de
    # emisión, que ya no se lee pero sigue ocupando su renglón —por eso las
    # zonas no son contiguas—. Se intenta por etiqueta porque el rótulo las
    # distingue sin ambigüedad, y se cae a la zona cuando el OCR no leyó el
    # rótulo, que es justo lo que pasa con el de vencimiento, tapado por el
    # holograma del sol.
    for nombre_campo, etiquetas, zona in (
        ("fecha_nacimiento", ("NACIMIENTO", "DATE OF BIRTH"), (0.26, 0.55, 0.62, 0.65)),
        ("fecha_vencimiento", ("VENCIMIENTO", "EXPIRY"), (0.26, 0.75, 0.62, 0.87)),
    ):
        crudo, confianza = lectura.debajo_de(*etiquetas)
        if not normalizar.fecha(crudo):
            crudo, confianza = lectura.mejor_en_zona(zona, normalizar.fecha)
        origen.campos[nombre_campo] = campo(
            normalizar.fecha(crudo), crudo, confianza
        )

    # El número está abajo a la izquierda, en cuerpo grande y con puntos de
    # millar. Tiene rótulo, así que se intenta por ahí primero.
    documento, conf_doc = lectura.debajo_de("DOCUMENTO", "DOCUMENT")
    if not normalizar.numero_documento(documento):
        documento, conf_doc = lectura.mejor_en_zona(
            (0.01, 0.82, 0.28, 1.0), normalizar.numero_documento
        )
    origen.campos["numero_documento"] = campo(
        normalizar.numero_documento(documento), documento, conf_doc
    )

    origen.detalle = {
        "texto_completo": lectura.texto_completo,
        "renglones": len(lectura.renglones),
        "confianza_media": round(lectura.confianza_media, 4),
    }
    return origen


def _del_codigo(codigos: list[lector_codigos.Codigo]) -> Origen:
    """Los datos del titular grabados en el PDF417."""
    origen = Origen(
        nombre="pdf417", disponible=True, campos=base.campos_vacios(*CAMPOS_CODIGO)
    )

    codigo = lector_codigos.primero(codigos, "PDF417")
    if codigo is None:
        origen.error = (
            "no se detectó el código PDF417 del frente. Tiene que entrar entero "
            "en la foto, enfocado y sin reflejos encima"
        )
        return origen

    datos = pdf417.parsear(codigo.texto)
    origen.detalle = {
        "crudo": datos.crudo,
        "formato_detectado": datos.formato_detectado,
        "partes": datos.partes,
        "variante_lectura": codigo.variante,
        "esquinas": codigo.esquinas,
    }

    if not datos.encontrado:
        origen.error = datos.error or "el contenido del código no se pudo interpretar"
        return origen

    origen.ok = True
    # Confianza 1.0 y no la del OCR: un código de barras trae corrección de
    # errores, así que si decodificó, decodificó bien. No hay grises.
    for nombre_campo, valor in (
        ("apellido", datos.apellido),
        ("nombre", datos.nombre),
        ("sexo", datos.sexo),
        ("numero_documento", datos.numero_documento),
        ("fecha_nacimiento", datos.fecha_nacimiento),
    ):
        origen.campos[nombre_campo] = campo(valor, valor, 1.0 if valor else 0.0)

    return origen

