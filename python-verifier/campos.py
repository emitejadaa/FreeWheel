"""
LEER LOS CAMPOS DE UNA FOTO
===========================

Todo lo que sale de la IMAGEN de un documento: OCR posicional por zonas, el
MRZ del dorso del DNI y el dorso de la licencia (que no tiene zonas fijas).
Los tres devuelven la misma estructura rica {valor, ok, motivo} con el
vocabulario de campos compartido, para que contrato.py la aplane sin saber de
dónde vino cada dato.

Cada campo se intenta leer de forma independiente: si uno falla queda con
valor None y su motivo, y el resto se arma igual. Nunca una excepción de un
campo corta el análisis de la foto.

El código de barras del DNI no pasa por acá: no depende de la rectificación y
lo decodifica codigos.py.

LAS ZONAS son el punto de partida: dónde está cada campo en la tarjeta ya
rectificada, como fracción (0.0-1.0) del ancho y el alto. Están calibradas a
ojo contra las fotos reales de testDocuments/ — se ajustan acá mismo si algún
recorte no cae sobre el texto correcto.
"""

from __future__ import annotations

import re
from typing import Any

from codigos import buscar_mrz, parsear_mrz_td1
from imagen import SEGURO, mejor_rotacion, rectificar_documento
from normalizadores import (
    limpiar_cuil,
    limpiar_domicilio,
    limpiar_nombre,
    limpiar_sexo,
    limpiar_solo_digitos,
    normalizar_fecha,
    sin_acentos,
)


# ══════════════════════════════════════════════════════════════════════════
#  Dónde está cada campo en la tarjeta rectificada
# ══════════════════════════════════════════════════════════════════════════

ZONAS: dict[str, dict[str, tuple[float, float, float, float]]] = {
    "dni_front": {
        "apellido":         (0.36, 0.18, 1.00, 0.28),
        "nombre":           (0.36, 0.31, 1.00, 0.41),
        "sexo":             (0.36, 0.44, 0.46, 0.53),
        "fechaNacimiento":  (0.36, 0.54, 0.75, 0.63),
        "fechaEmision":     (0.36, 0.64, 0.75, 0.73),
        "fechaVencimiento": (0.36, 0.74, 0.75, 0.84),
        "nDocumento":       (0.00, 0.85, 0.33, 1.00),
    },
    "dni_back": {
        "domicilio": (0.02, 0.04, 0.72, 0.18),
        "cuil":      (0.02, 0.52, 0.40, 0.62),
    },
    "license_front": {
        "numLicencia":      (0.36, 0.22, 0.60, 0.34),
        "apellido":         (0.36, 0.36, 0.80, 0.49),
        "nombre":           (0.38, 0.51, 0.65, 0.60),
        "domicilio":        (0.36, 0.59, 0.92, 0.79),
        "fechaNacimiento":  (0.34, 0.79, 0.62, 0.94),
        "fechaVencimiento": (0.62, 0.87, 0.98, 1.00),
    },
    # El dorso de la licencia no usa zonas: el CUIL y la leyenda de
    # principiante se buscan en el texto completo (extraccion_campos), porque
    # su posición varía entre jurisdicciones y el CUIL trae su propio dígito
    # verificador para validar la lectura.
}

# Franja del MRZ (dorso del DNI): tres líneas, se OCR-ea como bloque único y
# se parsea con buscar_mrz / parsear_mrz_td1 — no campo por campo, porque el
# MRZ se interpreta por posición de caracter dentro de la línea, no por
# ubicación visual.
ZONA_MRZ_DNI_DORSO: tuple[float, float, float, float] = (0.02, 0.68, 1.00, 1.00)


def zona_a_pixeles(
    zona: tuple[float, float, float, float],
    ancho: int,
    alto: int,
    padding: float = 0.02,
) -> tuple[int, int, int, int]:
    """Convierte una zona fraccionaria a un recorte en píxeles, con margen."""
    x0, y0, x1, y1 = zona
    pad_x = (x1 - x0) * padding
    pad_y = (y1 - y0) * padding
    x0 = max(0.0, x0 - pad_x)
    y0 = max(0.0, y0 - pad_y)
    x1 = min(1.0, x1 + pad_x)
    y1 = min(1.0, y1 + pad_y)
    return (int(x0 * ancho), int(y0 * alto), int(x1 * ancho), int(y1 * alto))


# ══════════════════════════════════════════════════════════════════════════
#  Fechas impresas
# ══════════════════════════════════════════════════════════════════════════

# "28 ABR 2027", "28/04/2027" o "28 04 2027". Una sola expresión para las dos
# búsquedas por texto (la fecha de principiante del dorso y las fechas del
# frente de la licencia): lo que no sea una fecha real lo descarta después
# normalizar_fecha.
_FECHA_IMPRESA = re.compile(
    r"\d{1,2}\s*[/-]?\s*(?:[A-ZÑ]{3}(?:\s*/?\s*[A-Z]{3})?|\d{1,2})\s*[/-]?\s*\d{4}"
)


def _fechas_cerca(lineas: list[str], indice: int) -> list[str]:
    """Las fechas interpretables del renglón y del siguiente: en los dos
    documentos el valor va pegado a su rótulo o justo debajo."""
    candidatas = _FECHA_IMPRESA.findall(lineas[indice])
    if indice + 1 < len(lineas):
        candidatas += _FECHA_IMPRESA.findall(lineas[indice + 1])
    return [f for f in (normalizar_fecha(c.strip()) for c in candidatas) if f]


# ══════════════════════════════════════════════════════════════════════════
#  OCR posicional por zonas
# ══════════════════════════════════════════════════════════════════════════

LIMPIADOR_POR_CAMPO = {
    "apellido": limpiar_nombre,
    "nombre": limpiar_nombre,
    "domicilio": limpiar_domicilio,
    "sexo": limpiar_sexo,
    "nDocumento": limpiar_solo_digitos,
    "numLicencia": limpiar_solo_digitos,
    "cuil": limpiar_cuil,
    "fechaNacimiento": normalizar_fecha,
    "fechaEmision": normalizar_fecha,
    "fechaVencimiento": normalizar_fecha,
}


def _campo_vacio(motivo: str, detalle: str) -> dict:
    return {"valor": None, "ok": False, "motivo": motivo, "detalle": detalle}


def _campos_vacios(documento_slot: str, motivo: str, detalle: str) -> dict[str, dict]:
    return {campo: _campo_vacio(motivo, detalle) for campo in ZONAS.get(documento_slot, {})}


CAMPOS_MULTILINEA = {"domicilio"}


def _ocr_lineas(imagen_preparada: Any, todas_las_lineas: bool) -> tuple[str, float, int]:
    """OCR de un recorte ya preparado. Devuelve (texto, confianza, cantidad
    de palabras reconocidas)."""
    import pytesseract
    from pytesseract import Output

    datos = pytesseract.image_to_data(imagen_preparada, lang="spa+eng", output_type=Output.DICT)

    lineas: dict[tuple[int, int, int], list[tuple[str, float]]] = {}
    tops_por_linea: dict[tuple[int, int, int], int] = {}
    for i, palabra in enumerate(datos.get("text", [])):
        palabra = palabra.strip()
        if not palabra:
            continue
        clave = (datos["block_num"][i], datos["par_num"][i], datos["line_num"][i])
        try:
            conf = float(datos["conf"][i])
        except (ValueError, TypeError):
            conf = -1.0
        lineas.setdefault(clave, []).append((palabra, conf))
        tops_por_linea.setdefault(clave, datos["top"][i])

    if not lineas:
        return "", 0.0, 0

    if todas_las_lineas:
        claves = sorted(lineas, key=tops_por_linea.get)
    else:
        claves = [max(tops_por_linea, key=tops_por_linea.get)]

    palabras_valor = [par for clave in claves for par in lineas[clave]]
    texto = " ".join(p for p, _ in palabras_valor)
    confianzas = [c for _, c in palabras_valor if c >= 0]
    confianza = sum(confianzas) / len(confianzas) if confianzas else 0.0
    return texto, confianza, len(palabras_valor)


def _preparar_recorte(recorte: Any, escala: int, preproceso: str) -> Any:
    """Escala + preprocesado de un recorte antes de pasarlo a Tesseract."""
    from PIL import ImageFilter, ImageOps

    agrandado = (
        recorte.resize((recorte.width * escala, recorte.height * escala))
        if escala > 1
        else recorte
    )
    if preproceso == "grises":
        return ImageOps.autocontrast(ImageOps.grayscale(agrandado))
    if preproceso == "grises_sharp":
        return ImageOps.autocontrast(ImageOps.grayscale(agrandado)).filter(
            ImageFilter.SHARPEN
        )
    return agrandado


# Variantes con las que se intenta leer cada zona, en orden. Las dos
# primeras alcanzan en una foto nítida; las demás rescatan fotos borrosas o
# con reflejo (verificado con las fotos reales de testDocuments: hay campos
# que solo salen en grises+autocontraste, y otros que solo salen planos).
_INTENTOS_ZONA: tuple[tuple[int, str], ...] = (
    (2, "plano"),
    (3, "plano"),
    (2, "grises"),
    (2, "grises_sharp"),
    (4, "plano"),
)


def _ocr_zona(
    imagen: Any,
    zona: tuple[float, float, float, float],
    todas_las_lineas: bool = False,
    validar: Any = None,
) -> tuple[str, float]:
    """OCR de una sola zona. Cada zona suele traer la etiqueta bilingüe
    arriba y el valor real abajo (así está impreso el DNI y la licencia) —
    se agrupa el texto por línea de Tesseract y se devuelve solo la ÚLTIMA
    línea (el valor), salvo que `todas_las_lineas` pida juntarlas todas
    (domicilio, que puede ocupar más de un renglón y no tiene una línea de
    etiqueta separada).

    Se prueban variantes (escala × preprocesado) en orden y se corta en la
    primera cuyo texto pasa `validar` (el limpiador del campo). Si ninguna
    valida, se devuelve la que más palabras reconoció, para que el motivo
    del fallo muestre qué se llegó a leer."""
    x0, y0, x1, y1 = zona_a_pixeles(zona, imagen.width, imagen.height)
    recorte = imagen.crop((x0, y0, x1, y1))
    if not recorte.width or not recorte.height:
        return "", 0.0

    mejor_texto, mejor_confianza, mejor_cantidad = "", 0.0, -1
    for escala, preproceso in _INTENTOS_ZONA:
        preparado = _preparar_recorte(recorte, escala, preproceso)
        texto, confianza, cantidad = _ocr_lineas(preparado, todas_las_lineas)
        if validar is not None and texto and validar(texto) is not None:
            return texto, confianza
        if cantidad > mejor_cantidad:
            mejor_texto, mejor_confianza, mejor_cantidad = texto, confianza, cantidad

    return mejor_texto, mejor_confianza


def extraer_campos_ocr(imagen_rectificada: Any, documento_slot: str) -> dict[str, dict]:
    resultado: dict[str, dict] = {}
    for campo, zona in ZONAS.get(documento_slot, {}).items():
        limpiador = LIMPIADOR_POR_CAMPO[campo]
        texto_crudo, confianza = _ocr_zona(
            imagen_rectificada,
            zona,
            todas_las_lineas=campo in CAMPOS_MULTILINEA,
            validar=limpiador,
        )
        valor = limpiador(texto_crudo)
        if valor is None:
            detalle = (
                f'Tesseract leyó "{texto_crudo}" en la zona esperada y no se '
                "pudo interpretar como dato válido."
                if texto_crudo
                else "Tesseract no reconoció texto en la zona esperada."
            )
            resultado[campo] = _campo_vacio("ZONA_NO_LEGIBLE", detalle)
        else:
            resultado[campo] = {"valor": valor, "ok": True, "confianza": round(confianza, 1)}
    return resultado


# ══════════════════════════════════════════════════════════════════════════
#  MRZ del dorso del DNI
# ══════════════════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════════════
#  MRZ del dorso del DNI
# ══════════════════════════════════════════════════════════════════════════

CAMPOS_MRZ = (
    "apellido",
    "nombre",
    "sexo",
    "nDocumento",
    "fechaNacimiento",
    "fechaVencimiento",
)


def _normalizar_largo_mrz(linea: str, largo: int = 30) -> str:
    """El relleno del MRZ es una tira de '<' sin información — el OCR a
    veces lo lee como L/K/otros y cambia el largo de la línea aunque el
    dato real (siempre al principio) haya salido bien. Se recorta o se
    completa con '<' al final para que parsear_mrz_td1 (que exige 30
    caracteres exactos) pueda intentar leer los campos igual."""
    if len(linea) >= largo:
        return linea[:largo]
    return linea + "<" * (largo - len(linea))


# Restringir el alfabeto al del MRZ mejora mucho la línea de los nombres
# (que no tiene dígito verificador propio): sin whitelist Tesseract mete
# minúsculas y puntuación que no existen en un MRZ.
_MRZ_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"
_MRZ_CONFIGS = (
    f"--psm 6 -c tessedit_char_whitelist={_MRZ_WHITELIST}",
    "--psm 6",
)


def _mrz_valido(resultado: dict) -> bool:
    """¿Este MRZ sirve como fuente de identidad? Deben cerrar los dígitos
    verificadores de los TRES campos con datos (documento, nacimiento,
    vencimiento). El control compuesto queda informativo: lo rompe el
    relleno de '<' mal transcripto (L/K), no un dato mal leído — los datos
    ya están cubiertos por sus propios verificadores."""
    if not resultado["ok"]:
        return False
    controles = resultado["controles"]
    return controles["documento"] and controles["nacimiento"] and controles["vencimiento"]


def _mrz_desde_imagen(imagen_derecha: Any) -> dict | None:
    """Intenta leer el MRZ en la franja esperada de una imagen ya
    rectificada. Solo se acepta si validan los dígitos verificadores de sus
    campos (ver _mrz_valido). None si no valida."""
    import pytesseract

    x0, y0, x1, y1 = zona_a_pixeles(ZONA_MRZ_DNI_DORSO, imagen_derecha.width, imagen_derecha.height, padding=0.0)
    recorte = imagen_derecha.crop((x0, y0, x1, y1))
    if recorte.width and recorte.height:
        recorte = recorte.resize((recorte.width * 2, recorte.height * 2))

    for config in _MRZ_CONFIGS:
        texto = pytesseract.image_to_string(recorte, lang="eng", config=config)
        lineas = buscar_mrz(texto)
        if len(lineas) < 3:
            continue

        resultado = parsear_mrz_td1([_normalizar_largo_mrz(l) for l in lineas[-3:]])
        if _mrz_valido(resultado):
            return resultado["datos"]

    return None


def _corregir_orientacion_dni_dorso(imagen_derecha: Any) -> tuple[Any, dict | None]:
    """El OSD de imagen.py no siempre acierta la orientación del dorso del DNI
    (documentado y aceptado como límite conocido). El MRZ trae sus propios
    dígitos verificadores, así que es una señal mucho más fuerte que la
    confianza genérica de OCR: se prueba cada rotación y gana la que valida."""
    def mrz(candidata: Any):
        datos = _mrz_desde_imagen(candidata)
        return (SEGURO, datos) if datos is not None else None

    imagen, _grados, datos = mejor_rotacion(imagen_derecha, mrz)
    return imagen, datos


def extraer_campos_mrz_dni_dorso(imagen_derecha: Any) -> tuple[dict[str, dict], Any]:
    """Devuelve (campos MRZ, imagen ya en la orientación que validó el MRZ)."""
    imagen_corregida, datos = _corregir_orientacion_dni_dorso(imagen_derecha)

    if datos is None:
        detalle = (
            "No se reconocieron, o no validaron sus dígitos verificadores, "
            "las tres líneas del MRZ en ninguna rotación."
        )
        return {campo: _campo_vacio("MRZ_NO_INTERPRETABLE", detalle) for campo in CAMPOS_MRZ}, imagen_corregida

    return {
        campo: (
            {"valor": datos[campo], "ok": True}
            if datos.get(campo) is not None
            else _campo_vacio(
                "MRZ_CAMPO_VACIO",
                f"El MRZ validó pero el campo {campo} vino vacío.",
            )
        )
        for campo in CAMPOS_MRZ
    }, imagen_corregida


# ══════════════════════════════════════════════════════════════════════════
#  Dorso de la licencia: CUIL y leyenda de principiante
#
#  Sin zonas fijas: la posición varía entre jurisdicciones y el propio dorso
#  suele venir en cualquier orientación. Se lee el texto completo en las 4
#  rotaciones y se elige la que produce un CUIL cuyo dígito verificador
#  cierra — un CUIL mal leído casi nunca pasa ese control por azar, así que
#  valida a la vez la lectura y la orientación.
# ══════════════════════════════════════════════════════════════════════════

# Candidatos a CUIL dentro de un texto: 11 dígitos con o sin separadores.


# ══════════════════════════════════════════════════════════════════════════
#  Dorso de la licencia: CUIL y leyenda de principiante
#
#  Sin zonas fijas: la posición varía entre jurisdicciones y el propio dorso
#  suele venir en cualquier orientación. Se lee el texto completo en las 4
#  rotaciones y se elige la que produce un CUIL cuyo dígito verificador
#  cierra — un CUIL mal leído casi nunca pasa ese control por azar, así que
#  valida a la vez la lectura y la orientación.
# ══════════════════════════════════════════════════════════════════════════

_CUIL_EN_TEXTO = re.compile(r"\d{2}[-–—.\s]?\d{8}[-–—.\s]?\d")

# "PRINCIPIANTE" tolerando las confusiones típicas del OCR (I/1/l).
_LEYENDA_PRINCIPIANTE = re.compile(r"PR[I1L]NC[I1L]P[I1L]ANTE")


def _cuil_en_texto(texto: str) -> str | None:
    for candidato in _CUIL_EN_TEXTO.findall(texto):
        cuil = limpiar_cuil(candidato)
        if cuil is not None:
            return cuil
    return None


def _texto_dorso_licencia(imagen_derecha: Any) -> str:
    """Texto completo del dorso en la mejor rotación. Primero la que trae un
    CUIL válido; si ninguna, la que más palabras reconoce."""
    import pytesseract

    def leer(candidata: Any):
        texto = pytesseract.image_to_string(candidata, lang="spa+eng")
        if _cuil_en_texto(texto) is not None:
            return SEGURO, texto
        return len(texto.split()), texto

    _imagen, _grados, texto = mejor_rotacion(imagen_derecha, leer)
    return texto or ""


def _principiante_en_lineas(lineas: list[str]) -> dict[str, dict]:
    """La leyenda de principiante dentro del texto ya normalizado.

    - Leyenda con fecha → esPrincipiante true + finPrincipiante.
    - Leyenda sin fecha interpretable → esPrincipiante true, finPrincipiante
      vacío (con motivo).
    - Texto legible sin leyenda → esPrincipiante false (no es principiante).
    """
    for indice, linea in enumerate(lineas):
        if not _LEYENDA_PRINCIPIANTE.search(linea):
            continue

        fechas = _fechas_cerca(lineas, indice)
        if fechas:
            return {
                "esPrincipiante": {"valor": True, "ok": True},
                "finPrincipiante": {"valor": fechas[0], "ok": True},
            }

        return {
            "esPrincipiante": {"valor": True, "ok": True},
            "finPrincipiante": _campo_vacio(
                "FECHA_PRINCIPIANTE_NO_LEGIBLE",
                "La leyenda de principiante está pero no se pudo interpretar "
                "su fecha límite.",
            ),
        }

    return {
        "esPrincipiante": {"valor": False, "ok": True},
        "finPrincipiante": {"valor": None, "ok": True},
    }


def extraer_dorso_licencia(imagen_derecha: Any) -> dict[str, dict]:
    """CUIL + leyenda de principiante del dorso, desde el texto completo."""
    texto = _texto_dorso_licencia(imagen_derecha)
    lineas = [sin_acentos(l).upper() for l in texto.splitlines() if l.strip()]

    if not lineas:
        detalle = "Tesseract no reconoció texto en el dorso de la licencia."
        return {
            "cuil": _campo_vacio("DORSO_NO_LEGIBLE", detalle),
            "esPrincipiante": _campo_vacio("DORSO_NO_LEGIBLE", detalle),
            "finPrincipiante": _campo_vacio("DORSO_NO_LEGIBLE", detalle),
        }

    cuil = _cuil_en_texto(texto)
    campos: dict[str, dict] = {
        "cuil": (
            {"valor": cuil, "ok": True}
            if cuil is not None
            else _campo_vacio(
                "CUIL_NO_LEGIBLE",
                "No apareció ningún CUIL con dígito verificador válido en el "
                "texto del dorso.",
            )
        )
    }
    campos.update(_principiante_en_lineas(lineas))
    return campos


# ══════════════════════════════════════════════════════════════════════════
#  Punto de entrada por foto
# ══════════════════════════════════════════════════════════════════════════


# Etiquetas impresas junto a cada fecha del frente de la licencia. El layout
# cambia entre jurisdicciones, así que cuando la zona fija no da resultado se
# busca la fecha por su etiqueta en el texto completo.


# ══════════════════════════════════════════════════════════════════════════
#  Frente de la licencia: fechas por etiqueta, cuando la zona fija no alcanza
# ══════════════════════════════════════════════════════════════════════════

_ETIQUETAS_FECHA_LICENCIA = {
    "fechaNacimiento": re.compile(r"FECHA DE NAC|DATE OF BIRTH"),
    "fechaVencimiento": re.compile(r"VENCIM[I1L]ENTO|EXP[I1L]RES"),
}

# "28 ABR 2027" o "28/04/2027".


def _fecha_por_etiqueta(lineas: list[str], etiqueta: Any) -> str | None:
    """La primera fecha interpretable en el renglón de la etiqueta o el
    siguiente (el valor suele ir debajo del rótulo bilingüe)."""
    for indice, linea in enumerate(lineas):
        if not etiqueta.search(linea):
            continue
        fechas = _fechas_cerca(lineas, indice)
        if fechas:
            return fechas[0]
    return None


def _completar_fechas_licencia(
    campos_ocr: dict[str, dict], imagen_derecha: Any
) -> None:
    """Respaldo para las fechas del frente de la licencia que la zona fija no
    pudo leer: se buscan por su etiqueta en el texto completo. Modifica
    `campos_ocr` en el lugar; si tampoco aparece, el campo queda como estaba
    (vacío con su motivo)."""
    faltantes = [
        campo
        for campo in _ETIQUETAS_FECHA_LICENCIA
        if not campos_ocr.get(campo, {}).get("ok")
    ]
    if not faltantes:
        return

    import pytesseract

    texto = pytesseract.image_to_string(imagen_derecha, lang="spa+eng")
    lineas = [sin_acentos(l).upper() for l in texto.splitlines() if l.strip()]
    if not lineas:
        return

    for campo in faltantes:
        fecha = _fecha_por_etiqueta(lineas, _ETIQUETAS_FECHA_LICENCIA[campo])
        if fecha:
            campos_ocr[campo] = {"valor": fecha, "ok": True}


def construir_campos(documento_slot: str, imagen_original: Any) -> dict:
    """Todo lo que sale de la IMAGEN de una foto (OCR posicional, MRZ,
    leyenda de principiante), agrupado por protocolo con la estructura rica
    {valor, ok, motivo}. El código de barras del DNI no pasa por acá: no
    depende de la rectificación y lo decodifica codigos_barras.py."""
    rectificacion = rectificar_documento(imagen_original)

    campos: dict[str, dict] = {}

    if not rectificacion.get("ok"):
        motivo = rectificacion["error"]["code"]
        detalle = rectificacion["error"]["message"]
        if documento_slot == "license_back":
            campos["ocr"] = {
                campo: _campo_vacio(motivo, detalle)
                for campo in ("cuil", "esPrincipiante", "finPrincipiante")
            }
            return campos
        campos["ocr"] = _campos_vacios(documento_slot, motivo, detalle)
        if documento_slot == "dni_back":
            campos["mrz"] = {campo: _campo_vacio(motivo, detalle) for campo in CAMPOS_MRZ}
        return campos

    imagen_derecha = rectificacion["imagen"]

    if documento_slot == "license_back":
        campos["ocr"] = extraer_dorso_licencia(imagen_derecha)
        return campos

    if documento_slot == "dni_back":
        campos["mrz"], imagen_derecha = extraer_campos_mrz_dni_dorso(imagen_derecha)

    campos["ocr"] = extraer_campos_ocr(imagen_derecha, documento_slot)

    if documento_slot == "license_front":
        _completar_fechas_licencia(campos["ocr"], imagen_derecha)

    return campos
