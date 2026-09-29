import functools
import io
import math
import operator
import re
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

import cv2
import numpy as np
import zxingcpp
from PIL import Image, ImageOps
from rapidocr import RapidOCR

from .texto import sin_tildes

ANCHO_CANONICO = 1600
ALTO_CANONICO = round(ANCHO_CANONICO / (85.6 / 54.0))
ANCHO_DETECCION = 1000
AREA_MINIMA = 0.12
FORMATOS_1D = frozenset({"Code128", "Code39", "Code93", "ITF", "Codabar"})
ESCALAS = (2, 3)
BINARIZADORES = (
    ("local", zxingcpp.Binarizer.LocalAverage),
    ("global", zxingcpp.Binarizer.GlobalHistogram),
    ("fijo", zxingcpp.Binarizer.FixedThreshold),
)

Zona = tuple[float, float, float, float]


def leer_imagen(datos: bytes, lado_maximo: int) -> np.ndarray:
    try:
        with Image.open(io.BytesIO(datos)) as original:
            original.draft("RGB", (lado_maximo, lado_maximo))
            imagen = ImageOps.exif_transpose(original).convert("RGB")
            if max(imagen.size) > lado_maximo:
                imagen.thumbnail((lado_maximo, lado_maximo), Image.Resampling.LANCZOS)
            return cv2.cvtColor(np.array(imagen), cv2.COLOR_RGB2BGR)
    except Exception as error:
        raise ValueError(f"no se pudo abrir la imagen: {error}") from error


def recortar(imagen: np.ndarray, zona: Zona) -> tuple[np.ndarray, tuple[int, int]]:
    alto, ancho = imagen.shape[:2]
    x0, y0 = max(0, int(zona[0] * ancho)), max(0, int(zona[1] * alto))
    return imagen[y0 : min(alto, int(zona[3] * alto)), x0 : min(ancho, int(zona[2] * ancho))], (x0, y0)


@dataclass
class Encuadre:
    imagen: np.ndarray
    metodo: str
    tamano_original: tuple[int, int]
    angulo: float = 0.0
    esquinas: list[list[int]] = field(default_factory=list)
    rotacion: int = 0

    def como_json(self) -> dict:
        return {
            "detectado": self.metodo != "ninguno",
            "metodo": self.metodo,
            "rotacion": self.rotacion,
            "angulo": round(self.angulo, 2),
            "esquinas": self.esquinas,
            "tamano_original": list(self.tamano_original),
            "tamano_encuadrado": [self.imagen.shape[1], self.imagen.shape[0]],
        }


def encuadrar(imagen: np.ndarray) -> Encuadre:
    alto, ancho = imagen.shape[:2]
    escala = min(1.0, ANCHO_DETECCION / ancho)
    chica = cv2.resize(imagen, None, fx=escala, fy=escala) if escala < 1 else imagen
    for metodo, buscar in (("contorno", _quad_por_bordes), ("umbral", _quad_por_color), ("minarea", _quad_por_minarea)):
        if (quad := buscar(chica)) is not None:
            esquinas = _ordenar(quad / escala)
            dx, dy = (esquinas[1] - esquinas[0]).tolist()
            return Encuadre(
                _corregir_perspectiva(imagen, esquinas),
                metodo,
                (ancho, alto),
                math.degrees(math.atan2(dy, dx)),
                [[int(x), int(y)] for x, y in esquinas],
            )
    return Encuadre(_estirar(imagen), "ninguno", (ancho, alto))


def _quad_por_bordes(imagen: np.ndarray) -> np.ndarray | None:
    gris = cv2.bilateralFilter(cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY), 11, 60, 60)
    for bajo, alto in ((30, 90), (60, 180)):
        bordes = cv2.morphologyEx(cv2.Canny(gris, bajo, alto), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=2)
        if (quad := _mejor_cuadrilatero(bordes, imagen.shape)) is not None:
            return quad
    return None


def _quad_por_color(imagen: np.ndarray) -> np.ndarray | None:
    hsv = cv2.cvtColor(imagen, cv2.COLOR_BGR2HSV)
    _, claro = cv2.threshold(hsv[:, :, 2], 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mascara = cv2.bitwise_and(claro, cv2.inRange(hsv[:, :, 1], 0, 110))
    mascara = cv2.morphologyEx(mascara, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8), iterations=2)
    mascara = cv2.morphologyEx(mascara, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    return _mejor_cuadrilatero(mascara, imagen.shape, rectangulo_minimo=True)


def _quad_por_minarea(imagen: np.ndarray) -> np.ndarray | None:
    gris = cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY)
    gradiente = cv2.morphologyEx(gris, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    _, binaria = cv2.threshold(gradiente, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    binaria = cv2.morphologyEx(binaria, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8), iterations=3)
    puntos = cv2.findNonZero(binaria)
    if puntos is None:
        return None
    rectangulo = cv2.minAreaRect(puntos)
    ancho, alto = rectangulo[1]
    if ancho * alto < imagen.shape[0] * imagen.shape[1] * AREA_MINIMA:
        return None
    return cv2.boxPoints(rectangulo).astype(np.float32)


def _mejor_cuadrilatero(binaria: np.ndarray, forma: tuple, rectangulo_minimo: bool = False) -> np.ndarray | None:
    contornos, _ = cv2.findContours(binaria, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    area_minima = forma[0] * forma[1] * AREA_MINIMA
    contornos = sorted(contornos, key=cv2.contourArea, reverse=True)[:6]
    for contorno in contornos:
        if cv2.contourArea(contorno) < area_minima:
            break
        perimetro = cv2.arcLength(contorno, True)
        for factor in (0.02, 0.03, 0.05, 0.08):
            aproximado = cv2.approxPolyDP(contorno, factor * perimetro, True)
            if len(aproximado) == 4 and cv2.isContourConvex(aproximado):
                quad = aproximado.reshape(4, 2).astype(np.float32)
                if _proporcion_de_tarjeta(quad):
                    return quad
    if rectangulo_minimo and contornos and cv2.contourArea(contornos[0]) >= area_minima:
        quad = cv2.boxPoints(cv2.minAreaRect(contornos[0])).astype(np.float32)
        if _proporcion_de_tarjeta(quad):
            return quad
    return None


def _ordenar(quad: np.ndarray) -> np.ndarray:
    quad = np.asarray(quad, dtype=np.float32).reshape(4, 2)
    suma, resta = quad.sum(axis=1), np.diff(quad, axis=1).ravel()
    return quad[[np.argmin(suma), np.argmin(resta), np.argmax(suma), np.argmax(resta)]]


def _lados(esquinas: np.ndarray) -> tuple[np.floating, np.floating]:
    arriba_izquierda, arriba_derecha, abajo_derecha, abajo_izquierda = esquinas
    horizontal = (
        np.linalg.norm(arriba_derecha - arriba_izquierda) + np.linalg.norm(abajo_derecha - abajo_izquierda)
    ) / 2
    vertical = (np.linalg.norm(abajo_izquierda - arriba_izquierda) + np.linalg.norm(abajo_derecha - arriba_derecha)) / 2
    return horizontal, vertical


def _proporcion_de_tarjeta(quad: np.ndarray) -> bool:
    horizontal, vertical = _lados(_ordenar(quad))
    corto, largo = sorted((horizontal, vertical))
    return corto >= 1 and 1.15 <= largo / corto <= 2.10


def _corregir_perspectiva(imagen: np.ndarray, esquinas: np.ndarray) -> np.ndarray:
    horizontal, vertical = _lados(esquinas)
    if vertical > horizontal:
        esquinas = np.roll(esquinas, -1, axis=0)
    destino = np.array(
        [[0, 0], [ANCHO_CANONICO - 1, 0], [ANCHO_CANONICO - 1, ALTO_CANONICO - 1], [0, ALTO_CANONICO - 1]],
        dtype=np.float32,
    )
    matriz = cv2.getPerspectiveTransform(esquinas, destino)
    return cv2.warpPerspective(imagen, matriz, (ANCHO_CANONICO, ALTO_CANONICO), flags=cv2.INTER_CUBIC)


def _estirar(imagen: np.ndarray) -> np.ndarray:
    if imagen.shape[0] > imagen.shape[1]:
        imagen = cv2.rotate(imagen, cv2.ROTATE_90_CLOCKWISE)
    return cv2.resize(imagen, (ANCHO_CANONICO, ALTO_CANONICO), interpolation=cv2.INTER_CUBIC)


@dataclass(frozen=True)
class Renglon:
    texto: str
    normalizado: str
    confianza: float
    x0: float
    y0: float
    x1: float
    y1: float

    def solapamiento(self, x0: float, y0: float, x1: float, y1: float) -> float:
        ancho = min(self.x1, x1) - max(self.x0, x0)
        alto = min(self.y1, y1) - max(self.y0, y0)
        area = (self.x1 - self.x0) * (self.y1 - self.y0)
        return ancho * alto / area if ancho > 0 and alto > 0 and area > 0 else 0.0


def _confianza_media(renglones: list[Renglon]) -> float:
    return sum(r.confianza for r in renglones) / len(renglones) if renglones else 0.0


class Lectura:
    def __init__(self, renglones: list[Renglon]):
        self.renglones = sorted(renglones, key=lambda r: (round(r.y0, 3), r.x0))
        self.texto_completo = "\n".join(r.texto for r in self.renglones)
        self.confianza_media = _confianza_media(self.renglones)

    def __bool__(self) -> bool:
        return bool(self.renglones)

    def en_zona(self, x0: float, y0: float, x1: float, y1: float) -> list[Renglon]:
        return [
            r
            for r in self.renglones
            if x0 <= (r.x0 + r.x1) / 2 <= x1
            and y0 <= (r.y0 + r.y1) / 2 <= y1
            and r.solapamiento(x0, y0, x1, y1) >= 0.45
        ]

    def texto_en_zona(self, *zona: float) -> tuple[str, float]:
        renglones = self.en_zona(*zona)
        return " ".join(r.texto for r in renglones), _confianza_media(renglones)

    def mejor_en_zona(self, zona: Zona, validar: Callable[[str], str]) -> tuple[str, float]:
        renglones = self.en_zona(*zona)
        for renglon in sorted(renglones, key=lambda r: (round(r.y0, 2), len(r.texto))):
            if validar(renglon.texto):
                return renglon.texto, renglon.confianza
        junto = " ".join(r.texto for r in renglones)
        if renglones and validar(junto):
            return junto, _confianza_media(renglones)
        return "", 0.0

    def buscar(self, fragmento: str) -> Renglon | None:
        return next((r for r in self.renglones if fragmento in r.normalizado), None)

    def despues_de_etiqueta(self, *etiquetas: str, validar: Callable[[str], object] = bool) -> tuple[str, float]:
        for etiqueta in etiquetas:
            for renglon in self.renglones:
                posicion = renglon.normalizado.find(etiqueta)
                if posicion < 0:
                    continue
                cola = renglon.texto[posicion + len(etiqueta) :].lstrip(" :.-/")
                if cola.strip() and validar(cola):
                    return cola.strip(), renglon.confianza
        return "", 0.0

    def debajo_de(self, *etiquetas: str, validar: Callable[[str], object] = bool) -> tuple[str, float]:
        for etiqueta in etiquetas:
            for i, renglon in enumerate(self.renglones):
                if etiqueta not in renglon.normalizado:
                    continue
                candidatos = [
                    otro
                    for otro in self.renglones[i + 1 :]
                    if otro.y0 > renglon.y0 + (renglon.y1 - renglon.y0) * 0.15 and abs(otro.x0 - renglon.x0) <= 0.22
                ]
                for candidato in candidatos[:3]:
                    if validar(candidato.texto):
                        return candidato.texto, candidato.confianza
        return "", 0.0

    def primer_patron(self, patron: str) -> tuple[str, float]:
        expresion = re.compile(patron, re.IGNORECASE)
        for renglon in self.renglones:
            if encontrado := expresion.search(renglon.texto):
                return encontrado.group(0), renglon.confianza
        if encontrado := expresion.search(self.texto_completo.replace("\n", " ")):
            return encontrado.group(0), self.confianza_media
        return "", 0.0


_motor: RapidOCR | None = None
_candado = threading.Lock()


def motor() -> RapidOCR:
    global _motor
    with _candado:
        if _motor is None:
            _motor = RapidOCR()
    return _motor


def motor_cargado() -> bool:
    return _motor is not None


def leer_texto(imagen: np.ndarray) -> Lectura:
    alto, ancho = imagen.shape[:2]
    luz, a, b = cv2.split(cv2.cvtColor(imagen, cv2.COLOR_BGR2LAB))
    luz = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8)).apply(luz)
    resultado = motor()(cv2.cvtColor(cv2.merge((luz, a, b)), cv2.COLOR_LAB2BGR))
    if resultado.boxes is None or resultado.txts is None:
        return Lectura([])
    renglones = []
    for caja, leido, puntaje in zip(resultado.boxes, resultado.txts, resultado.scores, strict=True):
        texto = str(leido).strip()
        if not texto:
            continue
        puntos = np.asarray(caja, dtype=np.float32).reshape(-1, 2)
        xs, ys = puntos[:, 0], puntos[:, 1]
        renglones.append(
            Renglon(
                texto,
                sin_tildes(texto).upper(),
                round(float(puntaje), 4),
                float(xs.min()) / ancho,
                float(ys.min()) / alto,
                float(xs.max()) / ancho,
                float(ys.max()) / alto,
            )
        )
    return Lectura(renglones)


def orientar(marco: Encuadre, anclas: tuple[str, ...]) -> Lectura:
    lectura = leer_texto(marco.imagen)
    puntaje = _puntaje(lectura, anclas)
    if puntaje >= max(2, len(anclas) // 2):
        return lectura
    invertida = cv2.rotate(marco.imagen, cv2.ROTATE_180)
    lectura_invertida = leer_texto(invertida)
    if (_puntaje(lectura_invertida, anclas), lectura_invertida.confianza_media) > (puntaje, lectura.confianza_media):
        marco.imagen, marco.rotacion = invertida, 180
        return lectura_invertida
    return lectura


def _puntaje(lectura: Lectura, anclas: tuple[str, ...]) -> int:
    normalizado = sin_tildes(lectura.texto_completo).upper()
    return sum(ancla in normalizado for ancla in anclas)


@dataclass
class Codigo:
    formato: str
    texto: str
    esquinas: list[list[int]]
    variante: str


def leer_codigos(imagenes: tuple[np.ndarray, ...], formatos: tuple[str, ...], zonas: tuple[Zona, ...]) -> list[Codigo]:
    concretos = {f for nombre in formatos for f in (FORMATOS_1D if nombre == "1D" else {nombre})}
    mascara = functools.reduce(operator.or_, (getattr(zxingcpp.BarcodeFormat, f) for f in concretos))
    con_barras = not concretos.isdisjoint({"PDF417", *FORMATOS_1D})
    for imagen in imagenes:
        gris = cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY)
        for etiqueta, recorte, origen, escala in _candidatos(gris, zonas, con_barras):
            if encontrados := _decodificar(recorte, mascara, etiqueta, origen, escala):
                return encontrados
    return []


def primero(codigos: list[Codigo], formatos: set[str] | frozenset[str]) -> Codigo | None:
    return next((codigo for codigo in codigos if codigo.formato in formatos), None)


def _candidatos(
    gris: np.ndarray, zonas: tuple[Zona, ...], con_barras: bool
) -> Iterator[tuple[str, np.ndarray, tuple[int, int], float]]:
    yield "completa", gris, (0, 0), 1.0
    for i, zona in enumerate(zonas):
        recorte, origen = recortar(gris, zona)
        if recorte.shape[0] >= 25 and recorte.shape[1] >= 40:
            yield from _ampliados(f"zona{i}", recorte, origen)
    if con_barras:
        for i, (region, origen) in enumerate(_regiones_con_barras(gris)):
            yield from _ampliados(f"detectada{i}", region, origen)
    if max(gris.shape) < 2200:
        yield "completa+2x", cv2.resize(gris, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC), (0, 0), 2.0


def _ampliados(
    nombre: str, recorte: np.ndarray, origen: tuple[int, int]
) -> Iterator[tuple[str, np.ndarray, tuple[int, int], float]]:
    for escala in ESCALAS:
        yield (
            f"{nombre}+{escala}x",
            cv2.resize(recorte, None, fx=escala, fy=escala, interpolation=cv2.INTER_CUBIC),
            origen,
            float(escala),
        )


def _regiones_con_barras(gris: np.ndarray) -> list[tuple[np.ndarray, tuple[int, int]]]:
    alto, ancho = gris.shape
    escala = min(1.0, 900 / ancho)
    chica = cv2.resize(gris, None, fx=escala, fy=escala) if escala < 1 else gris
    gradiente = cv2.convertScaleAbs(cv2.Sobel(chica, cv2.CV_32F, 1, 0, ksize=3))
    _, binaria = cv2.threshold(gradiente, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    unida = cv2.morphologyEx(binaria, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (21, 5)))
    unida = cv2.morphologyEx(unida, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (9, 3)))
    contornos, _ = cv2.findContours(unida, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    factor = 1 / escala
    regiones = []
    for contorno in sorted(contornos, key=cv2.contourArea, reverse=True)[:8]:
        x, y, w, h = (int(v * factor) for v in cv2.boundingRect(contorno))
        if w < ancho * 0.08 or h < alto * 0.03:
            continue
        margen_x, margen_y = int(w * 0.12) + 8, int(h * 0.18) + 8
        x0, y0 = max(0, x - margen_x), max(0, y - margen_y)
        x1, y1 = min(ancho, x + w + margen_x), min(alto, y + h + margen_y)
        regiones.append((gris[y0:y1, x0:x1], (x0, y0)))
    return regiones


def _decodificar(recorte: np.ndarray, mascara, etiqueta: str, origen: tuple[int, int], escala: float) -> list[Codigo]:
    for nombre_preparado, preparado in _preparados(recorte):
        for nombre_binarizador, binarizador in BINARIZADORES:
            resultados = zxingcpp.read_barcodes(preparado, formats=mascara, binarizer=binarizador, try_rotate=True)
            encontrados = [
                Codigo(
                    r.format.name,
                    r.text.strip(),
                    _esquinas(r.position, origen, escala),
                    f"{etiqueta}+{nombre_preparado}+{nombre_binarizador}",
                )
                for r in resultados
                if _utilizable(r.text.strip())
            ]
            if encontrados:
                return encontrados
    return []


def _preparados(recorte: np.ndarray) -> Iterator[tuple[str, np.ndarray]]:
    yield "crudo", recorte
    realzado = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(recorte)
    yield "contraste", realzado
    yield "otsu", cv2.threshold(realzado, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]


def _utilizable(texto: str) -> bool:
    return len(texto) >= 4 and all(c in "\n\t" or 32 <= ord(c) < 127 for c in texto)


def _esquinas(posicion, origen: tuple[int, int], escala: float) -> list[list[int]]:
    dx, dy = origen
    return [
        [int(punto.x / escala) + dx, int(punto.y / escala) + dy]
        for punto in (posicion.top_left, posicion.top_right, posicion.bottom_right, posicion.bottom_left)
    ]
