"""
EL OCR Y LA BÚSQUEDA POR POSICIÓN.

El motor (RapidOCR, modelos PP-OCR sobre ONNX Runtime) devuelve una lista de
renglones con su caja. Todo lo que hace falta encima de eso es poder preguntar
"qué dice acá", y ese "acá" se expresa de dos maneras:

  · por ZONA — un rectángulo en proporciones (0..1) sobre el documento ya
    encuadrado. Es lo que permite saber que lo que está en la esquina de abajo
    a la izquierda del DNI es el número de documento y no otra cosa.
  · por ETIQUETA — "buscá el renglón que dice 'Apellido' y devolveme el de
    abajo". Sobrevive a que la tarjeta esté un poco corrida, y es más robusto
    que una zona fija cuando el campo tiene largo variable (un domicilio ocupa
    una o dos líneas según el caso).

Cada extractor usa las dos: la etiqueta primero, la zona como respaldo.

El motor se carga una sola vez por proceso (`motor()`): instanciarlo levanta
tres modelos ONNX y tarda unos segundos, así que hacerlo por request haría que
cada análisis pagara ese arranque.
"""

from __future__ import annotations

import re
import threading
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass

import cv2
import numpy as np

_motor = None
_candado = threading.Lock()


@dataclass(frozen=True)
class Renglon:
    """Un renglón leído, con su caja en proporciones del documento (0..1)."""

    texto: str
    confianza: float
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def centro_y(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def centro_x(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def alto(self) -> float:
        return self.y1 - self.y0

    def normalizado(self) -> str:
        """El texto en mayúsculas y sin tildes, para comparar sin sorpresas."""
        return sin_tildes(self.texto).upper()


class Lectura:
    """
    Todos los renglones de un documento, con las consultas por posición encima.

    Es el objeto que recibe cada extractor: nunca vuelve a tocar la imagen, solo
    le pregunta a esta lista dónde está cada cosa.
    """

    def __init__(self, renglones: list[Renglon]):
        # Ordenados como se lee: de arriba abajo, y de izquierda a derecha
        # dentro de la misma línea. Así "el renglón siguiente" significa lo que
        # uno esperaría al mirar la tarjeta.
        self.renglones = sorted(renglones, key=lambda r: (round(r.y0, 3), r.x0))

    def __bool__(self) -> bool:
        return bool(self.renglones)

    @property
    def texto_completo(self) -> str:
        return "\n".join(r.texto for r in self.renglones)

    @property
    def confianza_media(self) -> float:
        if not self.renglones:
            return 0.0
        return sum(r.confianza for r in self.renglones) / len(self.renglones)

    # ── Consultas por zona ────────────────────────────────────────────────

    def en_zona(
        self,
        x0: float,
        y0: float,
        x1: float,
        y1: float,
        solapamiento: float = 0.45,
    ) -> list[Renglon]:
        """
        Los renglones cuyo centro cae en el rectángulo y que además solapan con
        él lo suficiente.

        Se piden las dos condiciones porque una sola falla: solo por centro
        entra un renglón largo que apenas lo pisa, y solo por solapamiento
        entra cualquier renglón que cruce la zona de punta a punta.
        """
        encontrados = []
        for renglon in self.renglones:
            if not (x0 <= renglon.centro_x <= x1 and y0 <= renglon.centro_y <= y1):
                continue
            ancho_comun = min(renglon.x1, x1) - max(renglon.x0, x0)
            alto_comun = min(renglon.y1, y1) - max(renglon.y0, y0)
            if ancho_comun <= 0 or alto_comun <= 0:
                continue
            area = (renglon.x1 - renglon.x0) * (renglon.y1 - renglon.y0)
            if area <= 0:
                continue
            if (ancho_comun * alto_comun) / area >= solapamiento:
                encontrados.append(renglon)
        return encontrados

    def texto_en_zona(self, *zona: float, separador: str = " ") -> tuple[str, float]:
        """El texto de una zona concatenado, con la confianza media."""
        renglones = self.en_zona(*zona)
        if not renglones:
            return "", 0.0
        texto = separador.join(r.texto.strip() for r in renglones if r.texto.strip())
        confianza = sum(r.confianza for r in renglones) / len(renglones)
        return texto.strip(), confianza

    def mejor_en_zona(
        self,
        zona: tuple[float, float, float, float],
        validar: Callable[[str], str],
    ) -> tuple[str, float]:
        """
        El renglón de una zona que el validador acepta, probándolos de a uno.

        Existe porque concatenar todo lo que cae en un rectángulo casi nunca da
        el valor buscado: en esta tarjeta los rótulos están pegados a los datos
        y arrastran. La zona del ejemplar agarra "Ejemplar" y "A"; la de la
        oficina agarra el número de trámite de arriba; la del vencimiento
        agarra el rótulo del renglón siguiente. Concatenados, ninguno pasa la
        normalización y el campo sale vacío teniendo el dato ahí.

        Probando renglón por renglón, el validador es el que elige: el que
        convierte a un valor no vacío es el correcto, porque los rótulos no
        pasan la normalización de un sexo, una fecha o un número.

        La concatenación queda como último intento, para el dato partido en
        dos renglones.
        """
        renglones = self.en_zona(*zona)
        if not renglones:
            return "", 0.0

        # De arriba abajo y, a igual altura, el más corto primero: un renglón
        # corto dentro de la zona suele ser el valor, y uno largo el rótulo.
        for renglon in sorted(renglones, key=lambda r: (round(r.y0, 2), len(r.texto))):
            if validar(renglon.texto):
                return renglon.texto.strip(), renglon.confianza

        junto = " ".join(r.texto.strip() for r in renglones if r.texto.strip())
        if validar(junto):
            confianza = sum(r.confianza for r in renglones) / len(renglones)
            return junto.strip(), confianza

        return "", 0.0

    # ── Consultas por etiqueta ────────────────────────────────────────────

    def buscar(self, *fragmentos: str) -> Renglon | None:
        """El primer renglón que contenga alguno de los fragmentos."""
        for fragmento in fragmentos:
            objetivo = sin_tildes(fragmento).upper()
            for renglon in self.renglones:
                if objetivo in renglon.normalizado():
                    return renglon
        return None

    def despues_de_etiqueta(
        self, *etiquetas: str, validar: Callable[[str], str] | None = None
    ) -> tuple[str, float]:
        """
        Lo que viene DESPUÉS de una etiqueta, en el mismo renglón.

        El caso "DOMICILIO: HAITI 2558" y el caso "Cuil: 20-49380010-9": el
        motor devuelve etiqueta y valor pegados en un solo renglón, así que se
        corta por el nombre de la etiqueta y se devuelve la cola.

        `validar` evita el falso positivo que da esta búsqueda cuando el
        renglón es SOLO el rótulo bilingüe: en "8. Domicilio/ Address" la cola
        después de "DOMICILIO" es "Address", que parece un valor y no lo es.
        Con un validador, esa cola se descarta y la búsqueda sigue.
        """
        for etiqueta in etiquetas:
            objetivo = sin_tildes(etiqueta).upper()
            for renglon in self.renglones:
                normalizado = renglon.normalizado()
                posicion = normalizado.find(objetivo)
                if posicion < 0:
                    continue
                cola = renglon.texto[posicion + len(objetivo) :].lstrip(" :.-/")
                if not cola.strip():
                    continue
                if validar is not None and not validar(cola):
                    continue
                return cola.strip(), renglon.confianza
        return "", 0.0

    def debajo_de(
        self,
        *etiquetas: str,
        validar: Callable[[str], str] | None = None,
        max_saltos: int = 2,
        tolerancia_x: float = 0.22,
    ) -> tuple[str, float]:
        """
        El renglón que está justo DEBAJO de una etiqueta y alineado con ella.

        Es la forma del DNI y de la licencia: el rótulo ("Apellido / Surname")
        arriba y el valor abajo. La alineación horizontal importa porque a la
        misma altura suele haber otra columna —"Sexo", "Nacionalidad" y
        "Ejemplar" comparten renglón—, y sin ese filtro se devuelve el valor de
        la columna de al lado.

        `validar` es lo que evita devolver el primer renglón que caiga debajo
        sea lo que sea. En la licencia, debajo de "2. Nombre / First name" el
        motor había leído un carácter suelto de basura antes que el nombre: sin
        validador eso ganaba y el campo terminaba vacío, con el valor correcto
        dos renglones más abajo.

        El umbral vertical es chico (0.15 del alto) porque en una foto con
        perspectiva las cajas del rótulo y del valor se superponen: exigir que
        el valor empiece claramente debajo dejaba afuera al valor correcto.
        """
        for etiqueta in etiquetas:
            objetivo = sin_tildes(etiqueta).upper()
            for indice, renglon in enumerate(self.renglones):
                if objetivo not in renglon.normalizado():
                    continue
                candidatos = [
                    otro
                    for otro in self.renglones[indice + 1 :]
                    if otro.y0 > renglon.y0 + renglon.alto * 0.15
                    and abs(otro.x0 - renglon.x0) <= tolerancia_x
                    and otro.texto.strip()
                ]
                for candidato in candidatos[: max_saltos + 1]:
                    if validar is not None and not validar(candidato.texto):
                        continue
                    return candidato.texto.strip(), candidato.confianza
        return "", 0.0

    def primer_patron(self, patron: str) -> tuple[str, float]:
        """
        La primera coincidencia de una expresión regular en todo el documento.

        Para los datos que tienen forma propia y no dependen de dónde estén: un
        CUIL, una fecha, un número de trámite. Si el dato se puede reconocer
        solo, buscarlo por forma es más robusto que por posición.
        """
        expresion = re.compile(patron, re.IGNORECASE)
        for renglon in self.renglones:
            encontrado = expresion.search(renglon.texto)
            if encontrado:
                return encontrado.group(0), renglon.confianza
        # Segunda pasada sobre el texto entero: cubre el dato partido en dos
        # renglones, que es lo que pasa con un domicilio largo.
        encontrado = expresion.search(self.texto_completo.replace("\n", " "))
        if encontrado:
            return encontrado.group(0), self.confianza_media
        return "", 0.0


def sin_tildes(texto: str) -> str:
    """Quita tildes y diéresis: el OCR las pone y las saca sin criterio fijo."""
    descompuesto = unicodedata.normalize("NFD", texto)
    return "".join(c for c in descompuesto if unicodedata.category(c) != "Mn")


def motor():
    """
    El motor de OCR del proceso. Se crea una sola vez y bajo candado: dos
    requests simultáneos en el arranque instanciarían dos motores y cada uno
    abriría los tres modelos ONNX por su cuenta.

    Los modelos NO se bajan de internet: `rapidocr` 3.x los trae adentro del
    paquete, en `site-packages/rapidocr/models/`. Lo que cuesta acá es abrir
    las tres sesiones de ONNX Runtime y reservarles memoria, que en una
    instancia con poca CPU son varios segundos — por eso `main.py` lo dispara
    apenas arranca el servicio, en vez de esperar al primer documento.
    """
    global _motor
    if _motor is None:
        with _candado:
            if _motor is None:
                from rapidocr import RapidOCR

                _motor = RapidOCR()
    return _motor


def leer(imagen: np.ndarray) -> Lectura:
    """
    Corre el OCR sobre un documento ya encuadrado y devuelve sus renglones con
    las cajas en proporciones (0..1).

    Se normaliza a proporciones y no a píxeles para que las zonas de los
    extractores valgan igual sea cual sea el tamaño con el que llegó la imagen.
    """
    alto, ancho = imagen.shape[:2]
    if alto == 0 or ancho == 0:
        return Lectura([])

    resultado = motor()(_preparar(imagen))

    cajas = getattr(resultado, "boxes", None)
    textos = getattr(resultado, "txts", None)
    puntajes = getattr(resultado, "scores", None)
    if cajas is None or textos is None:
        return Lectura([])

    renglones: list[Renglon] = []
    for indice, texto in enumerate(textos):
        if not texto or not str(texto).strip():
            continue
        puntos = np.array(cajas[indice], dtype=np.float32).reshape(-1, 2)
        xs, ys = puntos[:, 0], puntos[:, 1]
        confianza = float(puntajes[indice]) if puntajes is not None else 0.0
        renglones.append(
            Renglon(
                texto=str(texto).strip(),
                confianza=round(confianza, 4),
                x0=float(xs.min()) / ancho,
                y0=float(ys.min()) / alto,
                x1=float(xs.max()) / ancho,
                y1=float(ys.max()) / alto,
            )
        )
    return Lectura(renglones)


def _preparar(imagen: np.ndarray) -> np.ndarray:
    """
    Realce previo al OCR.

    Un DNI es plástico con una guarda de fondo impresa en colores claros justo
    abajo del texto. En escala de grises esa guarda compite con las letras, así
    que va un CLAHE sobre el canal de luminancia: sube el contraste local
    —letra contra su fondo inmediato— sin quemar las zonas ya claras, que es lo
    que pasaría con un ajuste de contraste global.
    """
    lab = cv2.cvtColor(imagen, cv2.COLOR_BGR2LAB)
    luz, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
    realzada = cv2.merge((clahe.apply(luz), a, b))
    return cv2.cvtColor(realzada, cv2.COLOR_LAB2BGR)
