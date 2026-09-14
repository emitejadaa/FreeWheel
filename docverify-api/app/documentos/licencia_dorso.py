"""
DORSO DE LA LICENCIA NACIONAL DE CONDUCIR.

    ┌─────────────────────────────────────────────────┐
    │ ▮▮▮ ▮ ▮▮▮ código de barras 1D ▮▮ ▮▮▮            │
    │ ┌────────┐  Grupo y factor / Blood type: -      │
    │ │        │  Observaciones / Observations:       │
    │ │ PDF417 │   Principiante hasta  28/10/2026     │
    │ │        │  Cuil: 20-49380010-9                 │
    │ └────────┘                    ┌───────────────┐ │
    │  LNC                          │ B.1           │ │
    │  YESICA PORCELLI              │ Automotores   │ │
    │  Responsable / in charge      │ uso particular│ │
    └─────────────────────────────────────────────────┘

TRES ORÍGENES — es el documento más rico de los cuatro:

  · ocr        — CUIL, clase y el período de principiante
  · pdf417     — los datos del titular grabados por la autoridad emisora
  · codigo_1d  — el código lineal del borde, que en general repite el número
                 de licencia

El dato que hace falta sacar bien de acá es el PERÍODO DE PRINCIPIANTE. Va en
"Observaciones" como texto libre ("Principiante hasta 28/10/2026") y determina
si la persona puede o no manejar sin acompañante. No está en ningún código: es
OCR o nada. Por eso se lo busca de varias formas y se devuelve desglosado en
dos campos, la condición y la fecha, en vez de dejar la frase entera para que
alguien la parsee después.

DOS COSAS QUE ESTA CARA TIENE IMPRESAS Y QUE A PROPÓSITO NO SE LEEN:

  · el GRUPO SANGUÍNEO y el renglón entero de OBSERVACIONES. Los dos son datos
    de salud —"Grupo y factor: 0+", "uso obligatorio de lentes"— y por lo tanto
    datos sensibles bajo la Ley 25.326. No hacen falta para alquilar un auto, y
    la única forma segura de no filtrar un dato es no tenerlo. De las
    observaciones se extrae únicamente si la licencia es de principiante y
    hasta cuándo, que es lo que habilita o restringe; la frase completa no sale
    de esta función.
  · el RESPONSABLE, el funcionario que firma la emisión: es el dato personal de
    un tercero que nunca pidió estar en nuestra base.
"""

from __future__ import annotations

import re

from .. import codigos as lector_codigos
from .. import encuadre, normalizar, ocr, pdf417
from ..contrato import Origen, campo
from . import base

CLAVE = "licencia_dorso"

ANCLAS = (
    "OBSERVACIONES",
    "OBSERVATIONS",
    "GRUPO Y FACTOR",
    "BLOOD TYPE",
    "CUIL",
    "RESPONSABLE",
    "IN CHARGE",
    "AUTOMOTORES",
    "PARTICULAR",
)

FORMATOS_CODIGO = ("PDF417", "QRCode", "1D")

# Dos zonas, medidas sobre el documento ya encuadrado: el PDF417 ancho de
# abajo al centro, y la tira del código lineal pegada al borde izquierdo.
#
# Van por separado y no en un solo recorte grande porque son dos formas muy
# distintas: el 1D es una tira finita, y metido dentro de un recorte que
# abarque también el PDF417 queda con tan poca altura relativa que el
# decodificador no lo busca.
ZONAS_CODIGO = (
    (0.20, 0.62, 0.95, 1.00),
    (0.00, 0.02, 0.18, 0.72),
)

CAMPOS_OCR = (
    "cuil",
    "numero_documento",
    "clase",
    "es_principiante",
    "fin_principiante",
)

CAMPOS_CODIGO = (
    "apellido",
    "nombre",
    "sexo",
    "numero_documento",
    "numero_licencia",
    "cuil",
    "clase",
    "fecha_nacimiento",
    "fecha_vencimiento",
)

# El contenido crudo del código lineal sigue viajando en `detalle`, donde sirve
# para diagnosticar; como CAMPO queda solo el número de licencia, y solo cuando
# el código realmente tiene forma de uno (ver _del_1d).
CAMPOS_1D = ("numero_licencia",)


def extraer(
    lectura: ocr.Lectura,
    codigos: list[lector_codigos.Codigo],
    marco: encuadre.Encuadre,
) -> list[Origen]:
    return [_del_texto(lectura), _del_pdf417(codigos), _del_1d(codigos)]


def _del_texto(lectura: ocr.Lectura) -> Origen:
    origen = Origen(
        nombre="ocr", disponible=True, campos=base.campos_vacios(*CAMPOS_OCR)
    )
    if not lectura:
        origen.error = "no se leyó texto en la imagen"
        return origen

    origen.ok = True

    # El CUIL por forma: el patrón es inconfundible y el dígito verificador
    # confirma la lectura sin necesidad de nada más.
    cuil_crudo, conf_cuil = lectura.primer_patron(r"\d{2}\s*-?\s*\d{7,8}\s*-?\s*\d")
    if not normalizar.cuil(cuil_crudo):
        cuil_crudo, conf_cuil = lectura.despues_de_etiqueta("CUIL")
    cuil_valor = normalizar.cuil(cuil_crudo)
    origen.campos["cuil"] = campo(cuil_valor, cuil_crudo, conf_cuil)

    if cuil_valor:
        derivado = cuil_valor.split("-")[1].lstrip("0")
        origen.campos["numero_documento"] = campo(
            derivado, f"derivado del CUIL {cuil_valor}", conf_cuil
        )

    # La clase está en un recuadro a la derecha, en cuerpo grande, con la
    # descripción de qué habilita al lado.
    clase, conf_clase = lectura.texto_en_zona(0.58, 0.05, 0.78, 0.35)
    if not normalizar.clase_licencia(clase):
        clase, conf_clase = lectura.primer_patron(r"\b[A-G]\.?\d(?:\.\d)?\b")
    origen.campos["clase"] = campo(
        normalizar.clase_licencia(clase), clase, conf_clase
    )

    # ── El período de principiante ────────────────────────────────────────
    # El renglón de observaciones se LEE pero no se publica: de todo lo que
    # puede decir, lo único que decide algo es si la licencia es de
    # principiante. El rótulo es bilingüe y el motor lo devuelve entero junto
    # con el valor ("Observaciones/ Observations: Principiante hasta
    # 28/10/2026"), así que se corta por la parte EN INGLÉS, que es la última:
    # cortando por "Observaciones" quedaría "/ Observations:" pegado adelante.
    observaciones, conf_obs = lectura.despues_de_etiqueta(
        "OBSERVATIONS", "OBSERVACIONES"
    )
    if not observaciones:
        observaciones, conf_obs = lectura.texto_en_zona(0.18, 0.55, 0.95, 0.75)

    # "Principiante" puede aparecer en el renglón de observaciones o suelto,
    # según cómo haya partido el OCR el bloque: se busca en todo el texto.
    texto_entero = normalizar.sin_tildes(lectura.texto_completo).upper()
    es_principiante = "PRINCIPIANTE" in texto_entero
    # El `crudo` dice qué se encontró, no lo que decía el renglón: copiar ahí
    # las observaciones o el texto del dorso volvería a meter por la ventana
    # —"uso obligatorio de lentes"— lo que se sacó por la puerta.
    origen.campos["es_principiante"] = campo(
        "true" if es_principiante else "false",
        "PRINCIPIANTE" if es_principiante else "sin la palabra PRINCIPIANTE",
        conf_obs if conf_obs else lectura.confianza_media,
    )

    if es_principiante:
        fin, conf_fin = _fecha_de_principiante(lectura, texto_entero)
        origen.campos["fin_principiante"] = campo(
            normalizar.fecha(fin), fin, conf_fin
        )

    # A diferencia de los otros tres documentos, acá el detalle NO lleva el
    # texto completo: el dorso de la licencia tiene impresos el grupo sanguíneo
    # y las observaciones, y volcarlo entero sería publicar por `detalle`
    # exactamente los datos de salud que los campos dejaron afuera.
    origen.detalle = {
        "renglones": len(lectura.renglones),
        "confianza_media": round(lectura.confianza_media, 4),
    }
    return origen


def _del_pdf417(codigos: list[lector_codigos.Codigo]) -> Origen:
    """
    El PDF417 del dorso. Su formato cambió entre emisiones y entre
    jurisdicciones, así que el parser lo ataca por ancla y, si no reconoce la
    estructura, rescata lo que pueda por forma. El contenido crudo viaja
    SIEMPRE en `detalle`, incluso cuando no se pudo interpretar: sin eso, un
    formato nuevo sería invisible desde afuera.
    """
    origen = Origen(
        nombre="pdf417", disponible=True, campos=base.campos_vacios(*CAMPOS_CODIGO)
    )

    codigo = lector_codigos.primero(codigos, "PDF417")
    if codigo is None:
        origen.error = (
            "no se detectó el código PDF417 del dorso. Tiene que entrar entero "
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
    # En la licencia argentina el número de licencia ES el número de documento.
    numero_licencia = datos.numero_licencia or datos.numero_documento
    for nombre_campo, valor in (
        ("apellido", datos.apellido),
        ("nombre", datos.nombre),
        ("sexo", datos.sexo),
        ("numero_documento", datos.numero_documento),
        ("numero_licencia", numero_licencia),
        ("cuil", datos.cuil),
        ("clase", datos.clase),
        ("fecha_nacimiento", datos.fecha_nacimiento),
        ("fecha_vencimiento", datos.fecha_vencimiento),
    ):
        origen.campos[nombre_campo] = campo(valor, valor, 1.0 if valor else 0.0)

    return origen


def _del_1d(codigos: list[lector_codigos.Codigo]) -> Origen:
    """
    El código de barras lineal del borde de la tarjeta.

    Su contenido crudo va SIEMPRE a `detalle`, y solo sale como campo
    `numero_licencia` cuando tiene la forma de uno. En la licencia con la que
    se probó esto el código dice "046909121" mientras que el número de licencia
    es "49380010": son nueve dígitos contra ocho, y no tienen nada que ver.
    Mapearlo a `numero_licencia` sin mirar habría puesto un número inventado en
    un campo que el backend compara contra el DNI de una persona.
    """
    origen = Origen(
        nombre="codigo_1d", disponible=True, campos=base.campos_vacios(*CAMPOS_1D)
    )

    codigo = lector_codigos.primero(codigos, "1d")
    if codigo is None:
        origen.error = "no se detectó el código de barras lineal del borde"
        return origen

    origen.ok = True
    origen.detalle = {
        "crudo": codigo.texto,
        "formato": codigo.formato,
        "variante_lectura": codigo.variante,
        "esquinas": codigo.esquinas,
    }

    # Un número de licencia argentino es el DNI: 7 u 8 dígitos. Nueve no lo es.
    digitos = "".join(c for c in codigo.texto if c.isdigit())
    if 7 <= len(digitos) <= 8:
        origen.campos["numero_licencia"] = campo(digitos, codigo.texto, 1.0)
    return origen


def _fecha_de_principiante(
    lectura: ocr.Lectura, texto_entero: str
) -> tuple[str, float]:
    """
    Hasta cuándo dura el período de principiante.

    Se busca primero la fecha que sigue a la palabra "hasta", y solo si eso no
    aparece se toma cualquier fecha del dorso. El orden importa: el dorso puede
    tener más de una fecha, y agarrar la primera que se cruce daría un dato mal
    que es peor que no tener el dato — de esta fecha depende si la persona
    puede manejar sola o no.
    """
    con_hasta = re.search(
        r"HASTA[^0-9]{0,12}(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})", texto_entero
    )
    if con_hasta:
        return con_hasta.group(1), lectura.confianza_media

    renglon = lectura.buscar("PRINCIPIANTE")
    if renglon is not None:
        suelta = re.search(r"\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}", renglon.texto)
        if suelta:
            return suelta.group(0), renglon.confianza

    return lectura.primer_patron(r"\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b")
