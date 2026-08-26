"""
LA FOTO, ANTES DE LEERLA
========================

Abrir el archivo y convertir una foto libre (cualquier ángulo, distancia y
rotación) en un rectángulo derecho con la proporción real de una tarjeta ID-1
(85.6×54mm), para que las zonas porcentuales de campos.py signifiquen lo mismo
sin importar cómo se sacó la foto.

Acá vive también `mejor_rotacion`, el probador de rotaciones que usan los tres
lugares donde hay que decidir para qué lado va la tarjeta.
"""

from __future__ import annotations

import io
import math
from pathlib import Path
from typing import Any

from contrato import desde_excepcion, error, ok

# Tope de la foto aceptada. Una foto de celular ronda los 3-5 MB.
MAX_IMAGE_BYTES = 15 * 1024 * 1024

# Proporción ISO/IEC 7810 ID-1, en píxeles del rectángulo de salida.
ANCHO_RECTIFICADO = 1600
ALTO_RECTIFICADO = 1010

# El contorno tiene que cubrir al menos esta fracción del área de la foto
# para considerarse "el documento" y no ruido de fondo.
AREA_MINIMA_FRACCION = 0.10

# Puntaje que corta la búsqueda de rotación: "es esta, no busques más".
SEGURO = math.inf


def abrir_imagen_desde_archivo(ruta: str) -> dict:
    """Ruta → imagen Pillow, o el motivo por el que no se pudo."""
    archivo = Path(ruta)
    if not archivo.is_file():
        return error("ARCHIVO_INEXISTENTE", f"No existe el archivo {ruta}.")

    datos = archivo.read_bytes()
    if not datos:
        return error("IMAGEN_VACIA", "La imagen llegó con cero bytes.")
    if len(datos) > MAX_IMAGE_BYTES:
        return error(
            "IMAGEN_MUY_GRANDE",
            f"La foto pesa {len(datos) // 1024} KB y el tope es "
            f"{MAX_IMAGE_BYTES // 1024} KB.",
        )

    from PIL import Image

    try:
        imagen = Image.open(io.BytesIO(datos))
        imagen.load()
    except BaseException as exc:  # noqa: BLE001 - Pillow tira de todo
        return desde_excepcion("NO_ES_UNA_IMAGEN", exc)

    if imagen.mode not in ("RGB", "L"):
        imagen = imagen.convert("RGB")
    imagen.format = "PNG"

    return ok(imagen=imagen)


def mejor_rotacion(imagen_pil: Any, evaluar: Any) -> tuple[Any, int, Any]:
    """Prueba la foto en las 4 rotaciones múltiplo de 90° y se queda con la
    mejor según `evaluar`.

    `evaluar(candidata)` devuelve `(puntaje, dato)`, o None si esa rotación
    no sirve. Gana el puntaje más alto; un puntaje `SEGURO` corta la búsqueda
    ahí mismo — es lo que devuelven las señales que se validan solas (el MRZ
    y el CUIL tienen dígitos verificadores: si cierran, esa ES la orientación
    y probar las otras tres es tiempo de OCR tirado).

    Devuelve (imagen elegida, grados aplicados, dato de la evaluación); si
    ninguna rotación sirvió, la original con 0 grados y dato None.
    """
    mejor = (imagen_pil, 0, None)
    mejor_puntaje = -math.inf

    for grados in (0, 90, 180, 270):
        candidata = imagen_pil.rotate(-grados, expand=True) if grados else imagen_pil
        evaluacion = evaluar(candidata)
        if evaluacion is None:
            continue
        puntaje, dato = evaluacion
        if puntaje > mejor_puntaje:
            mejor_puntaje, mejor = puntaje, (candidata, grados, dato)
        if puntaje == SEGURO:
            break

    return mejor


def _a_cv(imagen_pil: Any):
    import cv2
    import numpy as np

    return cv2.cvtColor(np.array(imagen_pil.convert("RGB")), cv2.COLOR_RGB2BGR)


def encontrar_contorno_documento(imagen_pil: Any):
    """Busca el contorno rectangular más grande de la foto. None si no hay
    uno confiable (área mínima + forma de 4 puntos, o el envolvente
    convexo de los fragmentos de borde reales cuando el propio dibujo de
    la tarjeta genera más ruido de bordes que su borde real y este nunca
    cierra limpio como un solo contorno)."""
    import cv2

    cv_img = _a_cv(imagen_pil)
    gris = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY)
    borroso = cv2.GaussianBlur(gris, (5, 5), 0)
    bordes = cv2.Canny(borroso, 30, 100)
    bordes = cv2.dilate(bordes, None, iterations=1)

    contornos, _ = cv2.findContours(bordes, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    if not contornos:
        return None

    area_imagen = cv_img.shape[0] * cv_img.shape[1]

    # Primer intento: el contorno de 4 puntos convexo más grande — el caso
    # limpio, documento sobre fondo despejado.
    mejor = None
    mejor_area = 0.0
    for contorno in contornos:
        perimetro = cv2.arcLength(contorno, True)
        aproximado = cv2.approxPolyDP(contorno, 0.02 * perimetro, True)
        if len(aproximado) != 4 or not cv2.isContourConvex(aproximado):
            continue
        area = cv2.contourArea(aproximado)
        if area < area_imagen * AREA_MINIMA_FRACCION:
            continue
        if area > mejor_area:
            mejor_area = area
            mejor = aproximado

    if mejor is not None:
        return mejor.reshape(4, 2)

    # Fallback: en fotos de bajo contraste el borde real de la tarjeta
    # queda fragmentado en varios contornos incompletos, mientras que el
    # dibujo interno (sellos, guilloché) forma contornos más chicos pero
    # completos por su cuenta — eso hace que "el contorno más grande"
    # termine siendo una región interna, no el borde real (se probó y
    # descartó: recorta la franja inferior de la tarjeta). El envolvente
    # convexo de los fragmentos de borde no depende de que ninguno haya
    # cerrado limpio: junta los pedazos.
    #
    # Antes de combinarlos hay que descartar los contornos que tocan 2 o
    # más bordes del cuadro entero — son el marco de la propia foto (o
    # artefactos de compresión/recorte a lo largo de un borde), no la
    # tarjeta. Si se los deja entrar, el envolvente explota hasta cubrir
    # casi el 100% del cuadro, fondo incluido (verificado empíricamente en
    # dniFrente/dniDorso: sin este filtro el envolvente cubre ~98% del
    # cuadro).
    import numpy as np

    ancho_imagen, alto_imagen = cv_img.shape[1], cv_img.shape[0]
    TOLERANCIA_BORDE_PX = 3
    UMBRAL_FRAGMENTO_FRACCION = 0.005

    def _toca_bordes_del_cuadro(contorno) -> int:
        x, y, ancho, alto = cv2.boundingRect(contorno)
        toques = 0
        if x <= TOLERANCIA_BORDE_PX:
            toques += 1
        if y <= TOLERANCIA_BORDE_PX:
            toques += 1
        if x + ancho >= ancho_imagen - TOLERANCIA_BORDE_PX:
            toques += 1
        if y + alto >= alto_imagen - TOLERANCIA_BORDE_PX:
            toques += 1
        return toques

    fragmentos = [
        contorno
        for contorno in contornos
        if cv2.contourArea(contorno) >= area_imagen * UMBRAL_FRAGMENTO_FRACCION
        and _toca_bordes_del_cuadro(contorno) < 2
    ]
    if not fragmentos:
        return None

    hull = cv2.convexHull(np.vstack(fragmentos))
    if cv2.contourArea(hull) < area_imagen * AREA_MINIMA_FRACCION:
        return None

    rectangulo = cv2.minAreaRect(hull)
    return cv2.boxPoints(rectangulo).astype("float32")


def _ordenar_puntos(puntos):
    """Ordena las 4 esquinas: arriba-izq, arriba-der, abajo-der, abajo-izq.
    No hace falta que acierte cuál es el "arriba" real de la tarjeta — eso lo
    corrige corregir_orientacion() después; esto solo evita que el warp
    salga con las esquinas cruzadas."""
    import numpy as np

    suma = puntos.sum(axis=1)
    diferencia = np.diff(puntos, axis=1).reshape(-1)
    return np.array(
        [
            puntos[np.argmin(suma)],
            puntos[np.argmin(diferencia)],
            puntos[np.argmax(suma)],
            puntos[np.argmax(diferencia)],
        ],
        dtype="float32",
    )


def rectificar_perspectiva(imagen_pil: Any, contorno) -> Any:
    """Aplica la corrección de perspectiva. Devuelve una imagen Pillow derecha.

    El lienzo de salida respeta la forma del contorno detectado (ancho >
    alto o al revés) en vez de forzar siempre un rectángulo apaisado: una
    licencia fotografiada de costado tiene un contorno alto y angosto en la
    foto original, y estirarlo a la fuerza a 1600×1010 lo distorsiona
    gravemente (probado empíricamente: el texto queda ilegible para OCR
    aunque a simple vista pase desapercibido). corregir_orientacion(),
    después, se encarga de rotar el resultado a la dirección de lectura
    correcta — acá solo importa no deformar el contenido.
    """
    import cv2
    import numpy as np
    from PIL import Image

    cv_img = _a_cv(imagen_pil)
    esquinas = _ordenar_puntos(contorno.astype("float32"))

    ancho_contorno = (
        np.linalg.norm(esquinas[1] - esquinas[0]) + np.linalg.norm(esquinas[2] - esquinas[3])
    ) / 2
    alto_contorno = (
        np.linalg.norm(esquinas[3] - esquinas[0]) + np.linalg.norm(esquinas[2] - esquinas[1])
    ) / 2

    if ancho_contorno >= alto_contorno:
        destino_ancho, destino_alto = ANCHO_RECTIFICADO, ALTO_RECTIFICADO
    else:
        destino_ancho, destino_alto = ALTO_RECTIFICADO, ANCHO_RECTIFICADO

    destino = np.array(
        [
            [0, 0],
            [destino_ancho - 1, 0],
            [destino_ancho - 1, destino_alto - 1],
            [0, destino_alto - 1],
        ],
        dtype="float32",
    )

    matriz = cv2.getPerspectiveTransform(esquinas, destino)
    resultado = cv2.warpPerspective(cv_img, matriz, (destino_ancho, destino_alto))
    return Image.fromarray(cv2.cvtColor(resultado, cv2.COLOR_BGR2RGB))


def corregir_orientacion(imagen_pil: Any) -> tuple[Any, int]:
    """Rota en múltiplos de 90° según el OSD de Tesseract. Se confía en el
    OSD solo cuando reporta script "Latin" (lo único que puede aparecer en
    estos documentos) — si reporta otra cosa, o falla, se prueban las 4
    rotaciones y se elige la que Tesseract lee con más confianza. Esto evita
    que un OSD de baja confianza (p.ej. detecta "Bengali" en un documento
    latino) rote una imagen que ya estaba derecha."""
    import pytesseract

    try:
        info = pytesseract.image_to_osd(imagen_pil, output_type=pytesseract.Output.DICT)
        if info.get("script") == "Latin":
            rotacion = int(info.get("rotate", 0)) % 360
            if rotacion == 0:
                return imagen_pil, 0
            return imagen_pil.rotate(-rotacion, expand=True), rotacion
    except Exception:
        pass

    return _mejor_rotacion_por_confianza(imagen_pil)


def _mejor_rotacion_por_confianza(imagen_pil: Any) -> tuple[Any, int]:
    """La rotación que Tesseract lee con mayor confianza promedio de palabra.
    Se usa cuando el OSD no reporta script "Latin" (señal de que su propia
    decisión de rotación tampoco es confiable en este documento)."""
    import pytesseract

    def confianza(candidata: Any):
        try:
            datos = pytesseract.image_to_data(
                candidata, lang="eng", output_type=pytesseract.Output.DICT
            )
        except Exception:
            return None
        confianzas = [float(c) for c in datos.get("conf", []) if str(c).strip() not in ("", "-1")]
        return (sum(confianzas) / len(confianzas), None) if confianzas else None

    elegida, grados, _ = mejor_rotacion(imagen_pil, confianza)
    return elegida, grados


def rectificar_documento(imagen_pil: Any) -> dict:
    """
    Punto de entrada: foto libre → imagen derecha con proporción ID-1, o el
    motivo por el que no se pudo.
    """
    try:
        import cv2  # noqa: F401
    except ImportError:
        return error(
            "SIN_OPENCV",
            "opencv-python-headless no está instalado: pip install -r requirements.txt",
        )
    try:
        import pytesseract

        pytesseract.get_tesseract_version()
    except Exception:
        return error(
            "SIN_TESSERACT",
            "pytesseract o el binario de tesseract no están disponibles: "
            "hacen falta para leer el texto y corregir la orientación.",
        )

    try:
        contorno = encontrar_contorno_documento(imagen_pil)
    except Exception as exc:
        return desde_excepcion("ERROR_DETECCION_BORDES", exc)

    if contorno is None:
        return error(
            "SIN_BORDES_DETECTADOS",
            "No se encontró el contorno del documento en la foto. Sacala con "
            "el documento entero dentro del cuadro, sobre un fondo que "
            "contraste, sin recortar los bordes.",
        )

    try:
        rectificada = rectificar_perspectiva(imagen_pil, contorno)
    except Exception as exc:
        return desde_excepcion("ERROR_RECTIFICACION", exc)

    orientada, grados = corregir_orientacion(rectificada)

    return ok(imagen=orientada, rotacionAplicada=grados)
