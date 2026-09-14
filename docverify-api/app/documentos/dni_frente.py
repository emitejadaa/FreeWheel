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

  · ocr    — todo lo impreso, incluido el VENCIMIENTO
  · pdf417 — los datos del titular tal como los grabó el RENAPER

El PDF417 NO trae el vencimiento: no está codificado ahí. O sea que el
vencimiento solo existe como texto impreso y no se puede contrastar contra
nada. Al revés, todo lo que sí está en los dos —apellido, nombre, sexo,
documento, nacimiento, emisión— se puede cruzar, y una discrepancia entre el
texto y el código es exactamente la señal de una tarjeta alterada.
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
    "nacionalidad",
    "ejemplar",
    "numero_documento",
    "fecha_nacimiento",
    "fecha_emision",
    "fecha_vencimiento",
    "numero_tramite",
    "oficina_identificadora",
)

# El código no codifica el vencimiento ni la oficina: sus campos son otros.
CAMPOS_CODIGO = (
    "apellido",
    "nombre",
    "sexo",
    "ejemplar",
    "numero_documento",
    "fecha_nacimiento",
    "fecha_emision",
    "numero_tramite",
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

    # Sexo, nacionalidad y ejemplar comparten un renglón de tres columnas bajo
    # sus rótulos. Van por zona porque `debajo_de` alinea por el borde
    # izquierdo y las tres columnas caen a la misma altura: la zona es lo único
    # que las separa. Y van por `mejor_en_zona` porque la zona agarra también
    # el rótulo de arriba —"Ejemplar" queda pegado a la "A"—: el validador es
    # el que descarta el rótulo y se queda con el valor.
    sexo, conf_sexo = lectura.mejor_en_zona((0.26, 0.43, 0.40, 0.56), normalizar.sexo)
    origen.campos["sexo"] = campo(normalizar.sexo(sexo), sexo, conf_sexo)

    nacionalidad, conf_nac = lectura.mejor_en_zona(
        (0.40, 0.44, 0.64, 0.58), _nacionalidad
    )
    origen.campos["nacionalidad"] = campo(
        _nacionalidad(nacionalidad), nacionalidad, conf_nac
    )

    ejemplar, conf_ej = lectura.mejor_en_zona((0.63, 0.46, 0.82, 0.60), _ejemplar)
    origen.campos["ejemplar"] = campo(_ejemplar(ejemplar), ejemplar, conf_ej)

    # Las tres fechas van una debajo de la otra con su rótulo. Se intenta por
    # etiqueta porque el rótulo las distingue sin ambigüedad, y se cae a la
    # zona cuando el OCR no leyó el rótulo —que es justo lo que pasa con el de
    # vencimiento, tapado por el holograma del sol.
    for nombre_campo, etiquetas, zona in (
        ("fecha_nacimiento", ("NACIMIENTO", "DATE OF BIRTH"), (0.26, 0.55, 0.62, 0.65)),
        ("fecha_emision", ("EMISION", "DATE OF ISSUE"), (0.26, 0.65, 0.62, 0.75)),
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

    # El trámite son 11 dígitos y la oficina 4, impresos uno debajo del otro
    # bajo el rótulo "Trámite N° / Of. ident.". El trámite se busca por forma:
    # 11 dígitos seguidos no son ninguna otra cosa en esta tarjeta. La oficina
    # no se puede buscar así —4 dígitos aparecen en varios lados— pero en su
    # zona es el único renglón de exactamente 4 dígitos.
    tramite, conf_tramite = lectura.primer_patron(r"\b\d{11}\b")
    origen.campos["numero_tramite"] = campo(tramite, tramite, conf_tramite)

    oficina, conf_oficina = lectura.mejor_en_zona((0.24, 0.88, 0.50, 1.0), _oficina)
    origen.campos["oficina_identificadora"] = campo(
        _oficina(oficina), oficina, conf_oficina
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
        ("ejemplar", datos.ejemplar),
        ("numero_documento", datos.numero_documento),
        ("fecha_nacimiento", datos.fecha_nacimiento),
        ("fecha_emision", datos.fecha_emision),
        ("numero_tramite", datos.numero_tramite),
    ):
        origen.campos[nombre_campo] = campo(valor, valor, 1.0 if valor else 0.0)

    return origen


def _ejemplar(valor: str) -> str:
    """
    El ejemplar es UNA letra suelta. Exigir exactamente un carácter es lo que
    descarta el rótulo "Ejemplar", que cae en la misma zona.
    """
    limpio = normalizar.texto(valor).upper()
    return limpio if len(limpio) == 1 and limpio.isalpha() else ""


def _nacionalidad(valor: str) -> str:
    """
    Una sola palabra de letras ("ARGENTINA"). El rótulo que comparte la zona
    —"Sexo / Sex Nacionalidad / Nationality"— trae barras y varias palabras,
    así que no pasa.
    """
    limpio = normalizar.sin_tildes(normalizar.texto(valor)).upper()
    return limpio if limpio.isalpha() and len(limpio) >= 4 else ""


def _oficina(valor: str) -> str:
    """
    La oficina identificadora son exactamente 4 dígitos. El número de trámite,
    que está justo encima y cae en la misma zona, tiene 11: así se separan.
    """
    digitos = "".join(c for c in (valor or "") if c.isdigit())
    return digitos if len(digitos) == 4 else ""
