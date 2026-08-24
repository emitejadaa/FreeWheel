"""
Arma los campos de cada foto: OCR posicional por zonas y, en el dorso del
DNI, el MRZ, todos reacomodados al mismo vocabulario de nombres de campo
(apellido, nombre, nDocumento, etc.) para poder comparar entre protocolos y
entre documentos.

Cada campo se intenta leer de forma independiente: si uno falla queda con
valor None y su motivo, y el resto se arma igual. Nunca una excepción de un
campo corta el análisis de la foto.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from document_geometry import rectificar_documento
from mrz import buscar_mrz, parsear_mrz_td1
from normalizadores_campos import (
    limpiar_cuil,
    limpiar_domicilio,
    limpiar_nombre,
    limpiar_sexo,
    limpiar_solo_digitos,
    normalizar_fecha,
)
from zonas_documento import ZONA_MRZ_DNI_DORSO, ZONAS, zona_a_pixeles

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
    """El OSD de document_geometry.py no siempre acierta la orientación del
    dorso del DNI (documentado y aceptado como límite conocido). El MRZ trae
    sus propios dígitos verificadores, así que es una señal mucho más fuerte
    que la confianza genérica de OCR: si no valida en la orientación que
    llegó, se prueban las otras 3 rotaciones y se usa la que sí valida."""
    datos = _mrz_desde_imagen(imagen_derecha)
    if datos is not None:
        return imagen_derecha, datos

    for grados in (90, 180, 270):
        candidata = imagen_derecha.rotate(-grados, expand=True)
        datos = _mrz_desde_imagen(candidata)
        if datos is not None:
            return candidata, datos

    return imagen_derecha, None


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
_CUIL_EN_TEXTO = re.compile(r"\d{2}[-–—.\s]?\d{8}[-–—.\s]?\d")

# "PRINCIPIANTE" tolerando las confusiones típicas del OCR (I/1/l).
_LEYENDA_PRINCIPIANTE = re.compile(r"PR[I1L]NC[I1L]P[I1L]ANTE")
_FECHA_EN_TEXTO = re.compile(r"\d{1,2}[/-]\d{1,2}[/-]\d{4}")


def _sin_acentos(texto: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", texto) if unicodedata.category(c) != "Mn"
    )


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

    mejor_texto, mejor_palabras = "", -1
    for grados in (0, 90, 180, 270):
        candidata = imagen_derecha.rotate(-grados, expand=True) if grados else imagen_derecha
        texto = pytesseract.image_to_string(candidata, lang="spa+eng")
        if _cuil_en_texto(texto) is not None:
            return texto
        palabras = len(texto.split())
        if palabras > mejor_palabras:
            mejor_texto, mejor_palabras = texto, palabras

    return mejor_texto


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

        # La fecha límite suele estar en el mismo renglón que la leyenda o
        # en el siguiente ("PRINCIPIANTE HASTA 28/10/2026").
        candidatas = _FECHA_EN_TEXTO.findall(linea)
        if indice + 1 < len(lineas):
            candidatas += _FECHA_EN_TEXTO.findall(lineas[indice + 1])

        for candidata in candidatas:
            fecha = normalizar_fecha(candidata)
            if fecha:
                return {
                    "esPrincipiante": {"valor": True, "ok": True},
                    "finPrincipiante": {"valor": fecha, "ok": True},
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
    lineas = [_sin_acentos(l).upper() for l in texto.splitlines() if l.strip()]

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
_ETIQUETAS_FECHA_LICENCIA = {
    "fechaNacimiento": re.compile(r"FECHA DE NAC|DATE OF BIRTH"),
    "fechaVencimiento": re.compile(r"VENCIM[I1L]ENTO|EXP[I1L]RES"),
}

# "28 ABR 2027" o "28/04/2027".
_FECHA_IMPRESA = re.compile(
    r"\d{1,2}\s*[/-]?\s*(?:[A-ZÑ]{3}(?:\s*/?\s*[A-Z]{3})?|\d{1,2})\s*[/-]?\s*\d{4}"
)


def _fecha_por_etiqueta(lineas: list[str], etiqueta: Any) -> str | None:
    """La primera fecha interpretable en el renglón de la etiqueta o el
    siguiente (el valor suele ir debajo del rótulo bilingüe)."""
    for indice, linea in enumerate(lineas):
        if not etiqueta.search(linea):
            continue
        candidatas = [m.group(0) for m in _FECHA_IMPRESA.finditer(linea)]
        if indice + 1 < len(lineas):
            candidatas += [
                m.group(0) for m in _FECHA_IMPRESA.finditer(lineas[indice + 1])
            ]
        for candidata in candidatas:
            fecha = normalizar_fecha(candidata.strip())
            if fecha:
                return fecha
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
    lineas = [_sin_acentos(l).upper() for l in texto.splitlines() if l.strip()]
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
