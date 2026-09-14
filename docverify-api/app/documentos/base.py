"""
EL ESQUELETO COMPARTIDO POR LOS CUATRO ANALIZADORES.

Cada documento se lee distinto —el frente del DNI tiene PDF417, el dorso tiene
MRZ, el frente de la licencia no tiene ningún código— pero los cuatro pasan por
los mismos pasos, y son estos:

    bytes → encuadre → orientación → OCR → códigos → campos → contrato

El único paso que no es obvio es la ORIENTACIÓN. El encuadre deja la tarjeta
derecha y apaisada, pero no sabe cuál de los dos lados va arriba: un
rectángulo y el mismo rectángulo girado 180° son indistinguibles mirando los
bordes. La única forma de decidirlo es INTENTAR LEER el documento en cada
orientación y ver cuál da un texto que se parece a lo que ese documento tiene
escrito. Eso hace `_orientar`.

Cada analizador aporta solo lo suyo: qué palabras esperar (para la
orientación), qué códigos buscar, y cómo sacar sus campos de lo leído.
"""

from __future__ import annotations

import time
from typing import Protocol

import numpy as np

from .. import codigos as lector_codigos
from .. import contrato, encuadre as encuadrador, ocr


class Analizador(Protocol):
    """Lo que tiene que aportar cada documento."""

    CLAVE: str
    """El identificador del documento: "dni_frente", "licencia_dorso"..."""

    ANCLAS: tuple[str, ...]
    """Palabras que este documento tiene impresas. Deciden la orientación."""

    FORMATOS_CODIGO: tuple[str, ...]
    """Qué códigos buscar. Vacío si el documento no tiene ninguno."""

    ZONAS_CODIGO: tuple[tuple[float, float, float, float], ...]
    """Dónde suelen estar los códigos, en proporciones del documento
    encuadrado. Es una pista para recortar y ampliar antes de decodificar, que
    es lo que hace la diferencia entre leer el PDF417 y no leerlo."""

    def extraer(
        self,
        lectura: ocr.Lectura,
        codigos: list[lector_codigos.Codigo],
        marco: encuadrador.Encuadre,
    ) -> list[contrato.Origen]:
        """
        Lo leído → los orígenes del contrato, con todos sus campos.

        Recibe también el encuadre porque hay lecturas que necesitan volver a
        la imagen: la MRZ del dorso del DNI se lee muchísimo mejor pasándole al
        OCR solo su franja que buscándola dentro del texto de toda la tarjeta.
        """


def analizar(datos: bytes, analizador: Analizador) -> dict:
    """
    El análisis completo de una foto. No lanza por un problema del documento:
    una imagen ilegible es una respuesta con los campos vacíos, no un 500.
    """
    arranque = time.perf_counter()

    try:
        imagen = encuadrador.leer_imagen(datos)
    except ValueError as error:
        return contrato.error_de_analisis(
            analizador.CLAVE, str(error), _ms(arranque)
        )

    marco = encuadrador.encuadrar(imagen)
    lectura = _orientar(marco, analizador.ANCLAS)

    codigos: list[lector_codigos.Codigo] = []
    if analizador.FORMATOS_CODIGO:
        # Se buscan los códigos en la imagen encuadrada Y en la original. La
        # encuadrada tiene la perspectiva corregida, que es lo que necesita un
        # PDF417 fotografiado de costado; la original conserva la resolución
        # completa, que es lo que necesita uno impreso chico. Cuál de las dos
        # gana depende de la foto, así que se prueban las dos.
        codigos = lector_codigos.leer_codigos(
            marco.imagen,
            imagen,
            formatos=analizador.FORMATOS_CODIGO,
            zonas=getattr(analizador, "ZONAS_CODIGO", ()),
        )

    origenes = analizador.extraer(lectura, codigos, marco)

    return contrato.respuesta(
        documento=analizador.CLAVE,
        encuadre=marco.como_json(),
        origenes=origenes,
        ms=_ms(arranque),
    )


def _orientar(marco: encuadrador.Encuadre, anclas: tuple[str, ...]) -> ocr.Lectura:
    """
    Deja el documento con el texto para arriba y devuelve su lectura.

    Se lee la tarjeta como está y, si el texto no se parece a lo que este
    documento tiene impreso, se la gira 180° y se lee de nuevo. Gana la
    orientación con más anclas encontradas; a igualdad, la que el OCR leyó con
    más confianza.

    El caso de 90° ya lo resolvió el encuadre (una tarjeta es apaisada, así que
    un recorte más alto que ancho se rota al warpear). Acá solo queda decidir
    derecho o cabeza abajo.
    """
    lectura = ocr.leer(marco.imagen)
    puntaje = _puntuar(lectura, anclas)

    # Con la mayoría de las anclas encontradas la orientación es evidente y
    # girar para comparar sería pagar un segundo OCR para confirmar lo obvio.
    if puntaje >= max(2, len(anclas) // 2):
        return lectura

    encuadrador.girar(marco, 180)
    lectura_invertida = ocr.leer(marco.imagen)
    puntaje_invertido = _puntuar(lectura_invertida, anclas)

    if puntaje_invertido > puntaje or (
        puntaje_invertido == puntaje
        and lectura_invertida.confianza_media > lectura.confianza_media
    ):
        return lectura_invertida

    # La original era mejor: se deshace el giro para que `rotacion` y las
    # esquinas informadas sigan describiendo lo que realmente se analizó.
    encuadrador.girar(marco, 180)
    return lectura


def _puntuar(lectura: ocr.Lectura, anclas: tuple[str, ...]) -> int:
    """Cuántas de las palabras esperadas aparecen en el texto leído."""
    if not lectura:
        return 0
    texto = ocr.sin_tildes(lectura.texto_completo).upper()
    return sum(1 for ancla in anclas if ocr.sin_tildes(ancla).upper() in texto)


def campos_vacios(*nombres: str) -> dict[str, contrato.Campo]:
    """
    Todos los campos de un origen, vacíos.

    Es lo que garantiza la regla del contrato: el juego de campos de un
    documento no cambia según lo que se haya podido leer. Cada extractor arranca
    de acá y va pisando lo que encuentra, así que un campo que nadie escribió
    queda vacío en vez de desaparecer.
    """
    return {nombre: contrato.Campo() for nombre in nombres}


def recorte(imagen: np.ndarray, x0: float, y0: float, x1: float, y1: float) -> np.ndarray:
    """Un pedazo de la imagen en proporciones (0..1), acotado a sus bordes."""
    alto, ancho = imagen.shape[:2]
    ax0 = max(0, min(ancho - 1, int(x0 * ancho)))
    ay0 = max(0, min(alto - 1, int(y0 * alto)))
    ax1 = max(ax0 + 1, min(ancho, int(x1 * ancho)))
    ay1 = max(ay0 + 1, min(alto, int(y1 * alto)))
    return imagen[ay0:ay1, ax0:ax1]


def _ms(arranque: float) -> int:
    return int((time.perf_counter() - arranque) * 1000)
