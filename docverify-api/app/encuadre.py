"""
EL ENCUADRE: de una foto sacada a mano a un documento derecho y recortado.

Todo lo que viene después —leer un campo porque está en tal parte de la
tarjeta— depende de que el documento esté bien encuadrado. Una foto de
teléfono llega girada, en perspectiva, con fondo alrededor y a veces al revés;
acá se corrige eso y se devuelve una imagen de tamaño fijo en la que las
coordenadas de cada campo son siempre las mismas.

El proceso, en orden:

  1. Orientación EXIF. Es por donde entra la mayoría de las fotos "giradas":
     el sensor guardó la imagen apaisada y un flag dice cómo mostrarla.
  2. Detección de los bordes de la tarjeta. Tres estrategias, de la más
     precisa a la más tolerante, y se usa la primera que cierre.
  3. Corrección de perspectiva a un tamaño canónico ID-1 (el de una tarjeta:
     85.6 × 54 mm).
  4. Orientación final. El warp deja un rectángulo derecho, pero no sabe cuál
     de los cuatro lados va arriba: eso lo decide quien llama, probando leer.

La salida incluye las cuatro esquinas EN COORDENADAS DE LA FOTO ORIGINAL, para
que se pueda dibujar encima de lo que subió la persona y ver qué detectó.
"""

from __future__ import annotations

import io
import math
import os
from dataclasses import dataclass, field

import cv2
import numpy as np
from PIL import Image, ImageOps


def _entero_de_entorno(nombre: str, defecto: int) -> int:
    crudo = os.environ.get(nombre, "").strip()
    try:
        return int(crudo) if crudo else defecto
    except ValueError:
        return defecto

# Relación de aspecto de una tarjeta ID-1 (ISO/IEC 7810): 85.6 × 54 mm. Es la
# del DNI argentino y la de la licencia nacional de conducir.
RELACION_ID1 = 85.6 / 54.0

# Tamaño al que se normaliza todo documento encuadrado. Las zonas de cada campo
# se expresan en proporciones (0..1), así que este número no cambia dónde cae
# un campo; sí cuánta resolución le queda al OCR. 1600 px de ancho deja la
# letra chica del dorso del DNI legible sin volver lento el análisis.
ANCHO_CANONICO = 1600
ALTO_CANONICO = int(round(ANCHO_CANONICO / RELACION_ID1))  # 1009

# Por debajo de esto el "documento" detectado es demasiado chico como para ser
# la tarjeta: casi siempre es un reflejo o un recorte de fondo.
AREA_MINIMA_RELATIVA = 0.12

# Ancho al que se reduce la imagen para BUSCAR los bordes. Detectar sobre la
# foto entera de 12 Mpx no mejora el contorno y multiplica el tiempo.
ANCHO_DETECCION = 1000

# Lado máximo de la foto que entra al análisis, en píxeles.
#
# ESTO ES LO QUE ACOTA LA MEMORIA DE TODO EL PIPELINE, y no es una
# micro-optimización: medido en una instancia de 512 MB, un análisis llegaba a
# 510 MB y el sistema mataba el proceso. La razón es que el tamaño de entrada se
# MULTIPLICA hacia abajo — el lector de códigos reescala la imagen entera al
# doble y al triple, busca en varias regiones y prueba varios preparados—, así
# que cada píxel de más se paga muchas veces.
#
# Una foto de teléfono ronda los 4000 px de lado: 4000×3000 en RGB son 36 MB
# por copia, antes de que nadie la toque. A 2400 px son 13 MB, y el documento
# se sigue leyendo igual de bien: una tarjeta que ocupa esos 2400 px deja el
# PDF417 con unos 15 píxeles por módulo, cuando el decodificador se conforma
# con 3 o 4. O sea que lo que se recorta acá es margen que no se usaba.
LADO_MAXIMO = _entero_de_entorno("DOCVERIFY_LADO_MAXIMO", 2400)


@dataclass
class Encuadre:
    """El resultado del encuadre, listo para serializar y para seguir usando."""

    imagen: np.ndarray
    """La tarjeta ya derecha y recortada, en tamaño canónico."""

    detectado: bool
    """Si se encontraron los bordes. False = se analiza la foto entera."""

    metodo: str
    """Cuál de las estrategias cerró: contorno | umbral | minarea | ninguno."""

    angulo: float
    """Inclinación corregida, en grados. Positivo = estaba rotada a la derecha."""

    rotacion: int
    """Múltiplo de 90° aplicado después del warp (lo fija `girar`)."""

    esquinas: list[list[int]] = field(default_factory=list)
    """Las 4 esquinas en coordenadas de la foto ORIGINAL, desde arriba-izquierda."""

    tamano_original: tuple[int, int] = (0, 0)
    """(ancho, alto) de la foto que subió la persona, ya rotada por EXIF."""

    def como_json(self) -> dict:
        return {
            "detectado": self.detectado,
            "metodo": self.metodo,
            "rotacion": self.rotacion,
            "angulo": round(self.angulo, 2),
            "esquinas": self.esquinas,
            "tamano_original": list(self.tamano_original),
            "tamano_encuadrado": [
                int(self.imagen.shape[1]),
                int(self.imagen.shape[0]),
            ],
        }


def leer_imagen(datos: bytes) -> np.ndarray:
    """
    Bytes → matriz BGR de OpenCV, respetando la orientación EXIF y acotada a
    LADO_MAXIMO.

    Se pasa por Pillow y no por `cv2.imdecode` directo por dos razones, y las
    dos importan:

    EL EXIF. OpenCV ignora ese flag, así que una foto vertical de teléfono
    entraba acostada y el resto del pipeline tenía que adivinar un giro que ya
    estaba declarado en el archivo.

    EL MODO BORRADOR. `draft()` le pide a libjpeg que decodifique a la mitad, a
    un cuarto o a un octavo mientras lee el archivo, sin materializar nunca la
    imagen completa en memoria. Achicar después de decodificar también
    funcionaría, pero habría que pagar el pico: una foto de 4000×3000 son 36 MB
    que en una instancia de 512 MB alcanzan para matar el proceso. Así ese pico
    no existe. Solo aplica a JPEG —que es lo que sacan los teléfonos—; para PNG
    o WebP queda el `thumbnail` de abajo.
    """
    try:
        with Image.open(io.BytesIO(datos)) as imagen:
            imagen.draft("RGB", (LADO_MAXIMO, LADO_MAXIMO))
            imagen = ImageOps.exif_transpose(imagen)
            imagen = imagen.convert("RGB")
            if max(imagen.size) > LADO_MAXIMO:
                # LANCZOS y no el default: al achicar una foto de documento, un
                # remuestreo pobre emborrona los trazos finos del texto y las
                # barras del código, que es justo lo que hay que leer.
                imagen.thumbnail((LADO_MAXIMO, LADO_MAXIMO), Image.LANCZOS)
            rgb = np.array(imagen)
    except Exception as error:  # noqa: BLE001 - el motivo se le devuelve al cliente
        raise ValueError(f"no se pudo abrir la imagen: {error}") from error

    if rgb.size == 0:
        raise ValueError("la imagen está vacía")

    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def encuadrar(imagen: np.ndarray) -> Encuadre:
    """
    Detecta el documento, corrige la perspectiva y lo normaliza al tamaño
    canónico. Si no encuentra los bordes devuelve la foto entera reescalada:
    un OCR sobre una foto sin recortar lee bastante menos, pero lee.
    """
    alto, ancho = imagen.shape[:2]
    escala = ANCHO_DETECCION / max(ancho, ANCHO_DETECCION)
    chica = cv2.resize(imagen, None, fx=escala, fy=escala) if escala < 1 else imagen

    for metodo, buscar in (
        ("contorno", _quad_por_contorno),
        ("umbral", _quad_por_umbral),
        ("minarea", _quad_por_minarea),
    ):
        quad = buscar(chica)
        if quad is None:
            continue
        # Las esquinas se encontraron sobre la imagen reducida: vuelven a la
        # escala original ANTES de recortar, así el warp usa todos los píxeles
        # que hay (recortar sobre la chica tiraría resolución que el OCR necesita).
        quad_original = quad / escala if escala < 1 else quad
        quad_original = _ordenar_esquinas(quad_original)
        recorte = _corregir_perspectiva(imagen, quad_original)
        return Encuadre(
            imagen=recorte,
            detectado=True,
            metodo=metodo,
            angulo=_inclinacion(quad_original),
            rotacion=0,
            esquinas=[[int(x), int(y)] for x, y in quad_original],
            tamano_original=(ancho, alto),
        )

    return Encuadre(
        imagen=_estirar(imagen),
        detectado=False,
        metodo="ninguno",
        angulo=0.0,
        rotacion=0,
        esquinas=[],
        tamano_original=(ancho, alto),
    )


def girar(encuadre: Encuadre, grados: int) -> Encuadre:
    """
    Gira el recorte en múltiplos de 90° y lo deja anotado en `rotacion`.

    Va aparte de `encuadrar` porque el warp deja la tarjeta derecha pero no
    sabe qué lado va arriba: eso solo se puede decidir intentando LEER el
    documento en cada orientación, y leer es trabajo del analizador.
    """
    grados = grados % 360
    if grados == 0:
        return encuadre

    codigo = {
        90: cv2.ROTATE_90_CLOCKWISE,
        180: cv2.ROTATE_180,
        270: cv2.ROTATE_90_COUNTERCLOCKWISE,
    }[grados]
    encuadre.imagen = cv2.rotate(encuadre.imagen, codigo)
    encuadre.rotacion = (encuadre.rotacion + grados) % 360
    return encuadre


# ── Las tres estrategias de detección ────────────────────────────────────────


def _quad_por_contorno(imagen: np.ndarray) -> np.ndarray | None:
    """
    La buena: bordes con Canny y el contorno de 4 lados más grande.

    Funciona cuando la tarjeta se recorta contra un fondo distinto. El
    documento es plástico brillante, así que antes del Canny va un filtro
    bilateral: suaviza los reflejos del plastificado sin comerse el borde, que
    es justo lo que se está buscando.
    """
    gris = cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY)
    gris = cv2.bilateralFilter(gris, 11, 60, 60)

    # Dos umbrales: uno flojo agarra bordes contra fondos parecidos; uno
    # exigente evita que un fondo con textura (una mesa de madera, una reja)
    # genere un cuadrilátero más grande que la tarjeta.
    for bajo, alto in ((30, 90), (60, 180)):
        bordes = cv2.Canny(gris, bajo, alto)
        # Los bordes de una foto salen cortados por reflejos y sombras; un
        # cierre morfológico los une para que el contorno sea uno solo.
        bordes = cv2.morphologyEx(
            bordes, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=2
        )
        quad = _mejor_cuadrilatero(bordes, imagen.shape)
        if quad is not None:
            return quad
    return None


def _quad_por_umbral(imagen: np.ndarray) -> np.ndarray | None:
    """
    Cuando el borde no se ve: separar el documento del fondo por color.

    Una tarjeta de identidad es clara y poco saturada; los fondos de estas
    fotos (una mesa, una baldosa, una reja) suelen ser más oscuros o más
    saturados. Con eso se arma una máscara y se busca el cuadrilátero ahí.
    """
    hsv = cv2.cvtColor(imagen, cv2.COLOR_BGR2HSV)
    saturacion, valor = hsv[:, :, 1], hsv[:, :, 2]

    # Otsu sobre el brillo: parte la foto en "lo claro" y "lo oscuro" sin que
    # haya que elegir un umbral fijo que falle con otra iluminación.
    _, claro = cv2.threshold(valor, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    poco_saturado = cv2.inRange(saturacion, 0, 110)
    mascara = cv2.bitwise_and(claro, poco_saturado)
    mascara = cv2.morphologyEx(
        mascara, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8), iterations=2
    )
    mascara = cv2.morphologyEx(
        mascara, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8), iterations=1
    )
    return _mejor_cuadrilatero(mascara, imagen.shape, desde_mascara=True)


def _quad_por_minarea(imagen: np.ndarray) -> np.ndarray | None:
    """
    El último recurso: el rectángulo rotado más chico que contiene todo lo que
    parece impreso. No recorta el fondo con precisión, pero endereza — que es
    lo que más le importa al OCR.
    """
    gris = cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY)
    # Gradiente morfológico: resalta cualquier transición brusca, o sea el
    # texto y las guardas del documento, y deja plano el fondo liso.
    gradiente = cv2.morphologyEx(gris, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    _, binaria = cv2.threshold(
        gradiente, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )
    binaria = cv2.morphologyEx(
        binaria, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8), iterations=3
    )

    puntos = cv2.findNonZero(binaria)
    if puntos is None:
        return None
    rect = cv2.minAreaRect(puntos)
    (_, _), (ancho_r, alto_r), _ = rect
    area_total = imagen.shape[0] * imagen.shape[1]
    if ancho_r * alto_r < area_total * AREA_MINIMA_RELATIVA:
        return None
    return cv2.boxPoints(rect).astype(np.float32)


def _mejor_cuadrilatero(
    binaria: np.ndarray, forma: tuple, desde_mascara: bool = False
) -> np.ndarray | None:
    """
    El cuadrilátero más grande y convexo de una imagen binaria.

    Se prueba aproximando el contorno a 4 vértices; si ninguno aproxima a 4
    —pasa cuando una esquina está redondeada o tapada— se cae al rectángulo
    rotado mínimo del contorno más grande, que sigue sirviendo para enderezar.
    """
    contornos, _ = cv2.findContours(
        binaria, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    if not contornos:
        return None

    area_total = forma[0] * forma[1]
    area_minima = area_total * AREA_MINIMA_RELATIVA
    contornos = sorted(contornos, key=cv2.contourArea, reverse=True)[:6]

    for contorno in contornos:
        if cv2.contourArea(contorno) < area_minima:
            break
        perimetro = cv2.arcLength(contorno, True)
        # Se prueban varias tolerancias de simplificación: una sola tolerancia
        # deja 5 o 6 vértices en un borde con ruido y 3 en uno muy redondeado.
        for factor in (0.02, 0.03, 0.05, 0.08):
            aprox = cv2.approxPolyDP(contorno, factor * perimetro, True)
            if len(aprox) == 4 and cv2.isContourConvex(aprox):
                quad = aprox.reshape(4, 2).astype(np.float32)
                if _proporcion_plausible(quad):
                    return quad

    if desde_mascara:
        mayor = contornos[0]
        if cv2.contourArea(mayor) >= area_minima:
            quad = cv2.boxPoints(cv2.minAreaRect(mayor)).astype(np.float32)
            if _proporcion_plausible(quad):
                return quad
    return None


def _proporcion_plausible(quad: np.ndarray) -> bool:
    """
    ¿La forma encontrada puede ser una tarjeta? Se acepta 1.15–2.10 de
    relación lado largo / lado corto (ID-1 es 1.585) para tolerar la
    perspectiva de una foto sacada de costado, pero se rechaza lo que es
    claramente otra cosa: un cuadrado, o una franja larga como un reflejo.
    """
    ordenado = _ordenar_esquinas(quad)
    arriba = np.linalg.norm(ordenado[1] - ordenado[0])
    abajo = np.linalg.norm(ordenado[2] - ordenado[3])
    izquierda = np.linalg.norm(ordenado[3] - ordenado[0])
    derecha = np.linalg.norm(ordenado[2] - ordenado[1])

    lado_a = (arriba + abajo) / 2
    lado_b = (izquierda + derecha) / 2
    if min(lado_a, lado_b) < 1:
        return False
    relacion = max(lado_a, lado_b) / min(lado_a, lado_b)
    return 1.15 <= relacion <= 2.10


def _ordenar_esquinas(quad: np.ndarray) -> np.ndarray:
    """
    Las 4 esquinas en orden horario desde arriba-izquierda.

    Por suma y resta de coordenadas: la esquina de arriba-izquierda es la de
    menor x+y y la de abajo-derecha la de mayor; las otras dos salen de y-x.
    Es estable ante rotaciones moderadas, que es lo único que hay acá porque
    el giro grande se corrige después.
    """
    quad = np.array(quad, dtype=np.float32).reshape(4, 2)
    suma = quad.sum(axis=1)
    resta = np.diff(quad, axis=1).ravel()
    return np.array(
        [
            quad[np.argmin(suma)],  # arriba-izquierda
            quad[np.argmin(resta)],  # arriba-derecha
            quad[np.argmax(suma)],  # abajo-derecha
            quad[np.argmax(resta)],  # abajo-izquierda
        ],
        dtype=np.float32,
    )


def _corregir_perspectiva(imagen: np.ndarray, quad: np.ndarray) -> np.ndarray:
    """
    Warp de las 4 esquinas al rectángulo canónico.

    Si el cuadrilátero detectado es más alto que ancho, la tarjeta estaba de
    costado: se rota el orden de las esquinas en vez de warpear a un rectángulo
    vertical. Warpear a vertical estiraría el documento a una proporción que no
    es la suya y dejaría el texto deformado.
    """
    ordenado = _ordenar_esquinas(quad)
    lado_horizontal = (
        np.linalg.norm(ordenado[1] - ordenado[0])
        + np.linalg.norm(ordenado[2] - ordenado[3])
    ) / 2
    lado_vertical = (
        np.linalg.norm(ordenado[3] - ordenado[0])
        + np.linalg.norm(ordenado[2] - ordenado[1])
    ) / 2
    if lado_vertical > lado_horizontal:
        ordenado = np.roll(ordenado, -1, axis=0)

    destino = np.array(
        [
            [0, 0],
            [ANCHO_CANONICO - 1, 0],
            [ANCHO_CANONICO - 1, ALTO_CANONICO - 1],
            [0, ALTO_CANONICO - 1],
        ],
        dtype=np.float32,
    )
    matriz = cv2.getPerspectiveTransform(ordenado, destino)
    return cv2.warpPerspective(
        imagen, matriz, (ANCHO_CANONICO, ALTO_CANONICO), flags=cv2.INTER_CUBIC
    )


def _estirar(imagen: np.ndarray) -> np.ndarray:
    """
    Sin bordes detectados: la foto entera llevada al tamaño canónico, apaisada.

    No se conserva la proporción a propósito. Las zonas de los campos están
    expresadas sobre un rectángulo ID-1, así que una imagen con otra forma las
    dejaría corridas; deformar es peor para mirar pero mejor para buscar.
    """
    if imagen.shape[0] > imagen.shape[1]:
        imagen = cv2.rotate(imagen, cv2.ROTATE_90_CLOCKWISE)
    return cv2.resize(
        imagen, (ANCHO_CANONICO, ALTO_CANONICO), interpolation=cv2.INTER_CUBIC
    )


def _inclinacion(quad: np.ndarray) -> float:
    """
    Cuántos grados estaba inclinado el documento, medido sobre el borde
    superior. Es informativo: la corrección ya la hizo el warp.
    """
    ordenado = _ordenar_esquinas(quad)
    dx = float(ordenado[1][0] - ordenado[0][0])
    dy = float(ordenado[1][1] - ordenado[0][1])
    if abs(dx) < 1e-6 and abs(dy) < 1e-6:
        return 0.0
    return math.degrees(math.atan2(dy, dx))
