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

  · ocr        — CUIL, observaciones, clase y su descripción, grupo sanguíneo
  · pdf417     — los datos del titular grabados por la autoridad emisora
  · codigo_1d  — el código lineal del borde, que en general repite el número
                 de licencia

El dato que hace falta sacar bien de acá es el PERÍODO DE PRINCIPIANTE. Va en
"Observaciones" como texto libre ("Principiante hasta 28/10/2026") y determina
si la persona puede o no manejar sin acompañante. No está en ningún código: es
OCR o nada. Por eso se lo busca de varias formas y se devuelve desglosado en
dos campos, la condición y la fecha, en vez de dejar la frase entera para que
alguien la parsee después.
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
    "clase_descripcion",
    "grupo_sanguineo",
    "observaciones",
    "es_principiante",
    "fin_principiante",
    "responsable",
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
    "fecha_emision",
    "fecha_vencimiento",
)

CAMPOS_1D = ("codigo_barras", "numero_licencia")


def extraer(
    lectura: ocr.Lectura,
    codigos: list[lector_codigos.Codigo],
    marco: encuadre.Encuadre,
) -> list[Origen]:
    return [_del_texto(lectura, marco), _del_pdf417(codigos), _del_1d(codigos)]


def _del_texto(lectura: ocr.Lectura, marco: encuadre.Encuadre) -> Origen:
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

    descripcion, conf_desc = lectura.buscar("AUTOMOTORES", "MOTOCICLETAS"), 0.0
    if descripcion is not None:
        origen.campos["clase_descripcion"] = campo(
            normalizar.texto(descripcion.texto),
            descripcion.texto,
            descripcion.confianza,
        )

    grupo, conf_grupo = lectura.despues_de_etiqueta(
        "BLOOD TYPE", "GRUPO Y FACTOR", "GRUPO"
    )
    origen.campos["grupo_sanguineo"] = campo(
        normalizar.grupo_sanguineo(grupo), grupo, conf_grupo
    )

    responsable, conf_resp = _responsable(lectura, marco)
    origen.campos["responsable"] = campo(
        normalizar.nombre(responsable), responsable, conf_resp
    )

    # ── Las observaciones y el período de principiante ────────────────────
    # El rótulo es bilingüe y el motor lo devuelve entero junto con el valor
    # ("Observaciones/ Observations: Principiante hasta 28/10/2026"), así que
    # se corta por la parte EN INGLÉS, que es la última: cortando por
    # "Observaciones" quedaría "/ Observations:" pegado adelante.
    observaciones, conf_obs = lectura.despues_de_etiqueta(
        "OBSERVATIONS", "OBSERVACIONES"
    )
    if not observaciones:
        observaciones, conf_obs = lectura.texto_en_zona(0.18, 0.55, 0.95, 0.75)
    origen.campos["observaciones"] = campo(
        normalizar.texto(observaciones), observaciones, conf_obs
    )

    # "Principiante" puede aparecer en el renglón de observaciones o suelto,
    # según cómo haya partido el OCR el bloque: se busca en todo el texto.
    texto_entero = normalizar.sin_tildes(lectura.texto_completo).upper()
    es_principiante = "PRINCIPIANTE" in texto_entero
    origen.campos["es_principiante"] = campo(
        "true" if es_principiante else "false",
        observaciones or lectura.texto_completo[:120],
        conf_obs if conf_obs else lectura.confianza_media,
    )

    if es_principiante:
        fin, conf_fin = _fecha_de_principiante(lectura, texto_entero)
        origen.campos["fin_principiante"] = campo(
            normalizar.fecha(fin), fin, conf_fin
        )

    origen.detalle = {
        "texto_completo": lectura.texto_completo,
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
        ("fecha_emision", datos.fecha_emision),
        ("fecha_vencimiento", datos.fecha_vencimiento),
    ):
        origen.campos[nombre_campo] = campo(valor, valor, 1.0 if valor else 0.0)

    return origen


def _del_1d(codigos: list[lector_codigos.Codigo]) -> Origen:
    """
    El código de barras lineal del borde de la tarjeta.

    Su contenido se devuelve SIEMPRE tal cual en `codigo_barras`, y solo se
    ofrece además como `numero_licencia` cuando tiene la forma de uno. En la
    licencia con la que se probó esto el código dice "046909121" mientras que
    el número de licencia es "49380010": son nueve dígitos contra ocho, y no
    tienen nada que ver. Mapearlo a `numero_licencia` sin mirar habría puesto
    un número inventado en un campo que alguien va a comparar contra el DNI de
    una persona.
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
    origen.campos["codigo_barras"] = campo(codigo.texto, codigo.texto, 1.0)

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


# Dónde está el nombre del responsable dentro del dorso encuadrado: el rincón
# de abajo a la derecha, arriba del rótulo "Responsable / in charge".
ZONA_RESPONSABLE = (0.75, 0.68, 1.00, 1.00)


def _responsable(
    lectura: ocr.Lectura, marco: encuadre.Encuadre
) -> tuple[str, float]:
    """
    El funcionario que firma la emisión.

    Está impreso en cuerpo muy chico y descolorido, en el rincón de abajo a la
    derecha, y leyendo el dorso entero el motor directamente NO LO VE: no
    aparece ni un renglón ahí. Por eso el camino principal es volver a pasarle
    el OCR a su rincón recortado, que es donde sí sale ("YESICAPORCELLI"). El
    texto general queda de respaldo, por si en otra foto aparece sin necesidad
    de insistir.
    """
    recorte = base.recorte(marco.imagen, *ZONA_RESPONSABLE)
    aislada = ocr.leer(recorte)
    if aislada:
        valor, confianza = aislada.mejor_en_zona((0.0, 0.0, 1.0, 1.0), _parece_nombre)
        if valor:
            return valor, confianza

    etiqueta = lectura.buscar("RESPONSABLE", "IN CHARGE", "RESPONSIBLE")
    if etiqueta is not None:
        candidatos = [
            renglon
            for renglon in lectura.renglones
            if renglon.y1 <= etiqueta.y0 + etiqueta.alto * 0.5
            and abs(renglon.centro_x - etiqueta.centro_x) < 0.20
            and _parece_nombre(renglon.texto)
        ]
        if candidatos:
            # El más abajo de los que están arriba: el inmediatamente superior.
            mas_cercano = max(candidatos, key=lambda r: r.y1)
            return mas_cercano.texto, mas_cercano.confianza

    return lectura.mejor_en_zona(ZONA_RESPONSABLE, _parece_nombre)


def _parece_nombre(valor: str) -> str:
    """
    Algo con forma de nombre de persona: solo letras, sin dígitos, y con
    cuerpo suficiente.

    Se acepta UNA sola palabra larga además de dos o más cortas, porque acá el
    motor devuelve el nombre sin el espacio del medio —"YESICAPORCELLI"— y
    exigir dos palabras dejaba el campo vacío teniendo el dato leído. Lo que
    descarta el ruido es el largo: el logo "LNC" y los restos de la guarda de
    seguridad no llegan a seis letras.
    """
    limpio = normalizar.nombre(valor)
    if any(c.isdigit() for c in valor or ""):
        return ""
    partes = [p for p in limpio.split() if len(p) >= 3]
    if len(partes) >= 2:
        return " ".join(partes)
    if len(partes) == 1 and len(partes[0]) >= 8:
        return partes[0]
    return ""
