"""
LA LECTURA DE CÓDIGOS: PDF417, QR y códigos de barras lineales.

Un solo motor (zxing-cpp) lee los tres formatos. Lo difícil no es elegir la
librería: es que el código ENTRE en condiciones de ser leído.

Lo que se aprendió probando contra fotos reales, y que explica toda la
estrategia de acá abajo:

  · Pasarle la foto ENTERA al decodificador no funciona. Un DNI de 4032 px de
    ancho tiene el PDF417 ocupando apenas una franja, y el decodificador lo
    ignora o lo lee con errores. La misma foto, RECORTADA a la zona del código
    y ampliada al doble, se lee limpia y a la primera.
  · El binarizador importa tanto como el recorte. Con el default
    (LocalAverage) el mismo código fallaba; con el recorte bien hecho pasa con
    cualquiera de los cuatro.
  · Un PDF417 puede decodificar MAL y devolver texto igual. La corrección de
    errores del formato tapa el daño hasta cierto punto y después entrega
    basura —"TEJADA A:60/N@H\r��IANO"— que parece un resultado válido. Por eso
    todo lo que sale de acá pasa por `_utilizable`: estos códigos son ASCII
    imprimible, y un resultado con bytes de control es un resultado roto, no un
    resultado pobre.

Por eso la búsqueda es: encontrar dónde está el código (por zona declarada o
detectándolo), recortarlo, ampliarlo, y recién ahí decodificar.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Iterator

import cv2
import numpy as np

# Los formatos que aparecen en estos documentos:
#   · PDF417 → frente del DNI y dorso de la licencia (los datos del titular)
#   · QR     → no está en el DNI ni en la licencia actuales, pero se busca
#              igual: hay jurisdicciones y versiones que lo agregan, y mirar
#              en la misma pasada no cuesta nada.
#   · 1D     → el código lineal del borde del dorso de la licencia
#
# La lista de 1D es corta A PROPÓSITO. Con los formatos de supermercado
# adentro —DataBar, EAN, UPC— el decodificador encontraba códigos donde no los
# hay: la guarda de seguridad del dorso de la licencia le daba un "DataBar
# 44054702434315" que no existe, y como la búsqueda corta en el primer
# hallazgo, ese fantasma tapaba el Code128 real del borde. Cuantos menos
# formatos se habilitan, menos margen hay para inventar.
FORMATOS_1D = {"Code128", "Code39", "Code93", "ITF", "Codabar"}

# Ampliar el recorte es lo que más mueve la aguja: un PDF417 impreso chico
# tiene módulos de menos de un píxel efectivo, y ampliarlo los separa. 2x
# alcanzó en todas las pruebas; 3x queda como segundo intento.
ESCALAS = (2, 3)


@dataclass
class Codigo:
    """Un código leído: qué formato, qué dice y dónde estaba."""

    formato: str
    texto: str
    esquinas: list[list[int]]
    variante: str
    """Cómo se pudo leer: "zona+2x+otsu", "completa", etc. Cuando un código
    falla en producción, esto dice qué camino era el que lo estaba salvando."""

    def como_json(self) -> dict:
        return {
            "formato": self.formato,
            "texto": self.texto,
            "esquinas": self.esquinas,
            "variante": self.variante,
        }


def leer_codigos(
    *imagenes: np.ndarray,
    formatos: Iterable[str] | None = None,
    zonas: Iterable[tuple[float, float, float, float]] = (),
) -> list[Codigo]:
    """
    Busca códigos, insistiendo por varios caminos hasta que uno lea.

    `zonas` son rectángulos en proporciones (0..1) donde el documento tiene sus
    códigos, declarados por cada analizador. Son una PISTA, no un requisito: si
    ninguna da resultado se cae a detectar la zona del código por su textura, y
    eso cubre el caso de un encuadre corrido o de una emisión con otro diseño.

    Se le pasan la imagen encuadrada y la original porque ganan en casos
    distintos: la encuadrada tiene la perspectiva corregida (lo que necesita un
    código fotografiado de costado) y la original conserva todos los píxeles
    (lo que necesita uno impreso chico).
    """
    buscados = set(formatos) if formatos else None

    # La detección de regiones busca TEXTURA DE BARRAS: franjas verticales muy
    # juntas. Eso describe un PDF417 y un código lineal, no un QR, que es una
    # retícula. Correrla buscando solo QR es pagar el barrido completo —dos
    # imágenes, varias regiones, dos escalas, tres preparados, tres
    # binarizadores— para nada: en el dorso del DNI eso convertía un análisis
    # de 8 segundos en uno de 46.
    con_barras = buscados is None or any(
        _coincide(f, {"PDF417"}) or _coincide(f, FORMATOS_1D) or f.lower() == "1d"
        for f in buscados
    )

    for imagen in imagenes:
        if imagen is None or imagen.size == 0:
            continue
        gris = cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY)

        for etiqueta, recorte, desplazamiento, escala in _candidatos(
            gris, zonas, con_barras
        ):
            encontrados = _decodificar(
                recorte, buscados, etiqueta, desplazamiento, escala
            )
            if encontrados:
                return encontrados

    return []


def primero(codigos: list[Codigo], *formatos: str) -> Codigo | None:
    """El primer código de alguno de los formatos pedidos."""
    for codigo in codigos:
        for formato in formatos:
            if formato.lower() == "1d":
                if _coincide(codigo.formato, FORMATOS_1D):
                    return codigo
            elif _coincide(codigo.formato, {formato}):
                return codigo
    return None


# ── Dónde mirar ──────────────────────────────────────────────────────────────


def _candidatos(
    gris: np.ndarray,
    zonas: Iterable[tuple[float, float, float, float]],
    con_barras: bool,
) -> Iterator[tuple[str, np.ndarray, tuple[int, int], float]]:
    """
    Los pedazos de imagen donde probar, en orden de conveniencia.

    Cada uno viene con su desplazamiento y su escala para poder devolver las
    coordenadas del código en la imagen de entrada y no en el recorte.

    El orden es deliberado: primero lo barato (la imagen entera, que resuelve
    los códigos grandes y nítidos), después las zonas declaradas ampliadas
    (que es lo que resuelve el caso real), y al final la detección automática
    (más cara, y solo hace falta cuando el encuadre no salió como se esperaba).
    """
    alto, ancho = gris.shape[:2]

    yield "completa", gris, (0, 0), 1.0

    for indice, (x0, y0, x1, y1) in enumerate(zonas):
        recorte, origen = _recortar(gris, x0, y0, x1, y1)
        if recorte is None:
            continue
        for escala in ESCALAS:
            yield (
                f"zona{indice}+{escala}x",
                cv2.resize(
                    recorte, None, fx=escala, fy=escala, interpolation=cv2.INTER_CUBIC
                ),
                origen,
                float(escala),
            )

    regiones = _regiones_con_textura(gris) if con_barras else []
    for indice, (region, origen) in enumerate(regiones):
        for escala in ESCALAS:
            yield (
                f"detectada{indice}+{escala}x",
                cv2.resize(
                    region, None, fx=escala, fy=escala, interpolation=cv2.INTER_CUBIC
                ),
                origen,
                float(escala),
            )

    # Último recurso: la imagen entera ampliada. Cara en memoria, pero rescata
    # el caso de una foto de baja resolución donde no hay zona que recortar.
    if max(alto, ancho) < 2200:
        yield (
            "completa+2x",
            cv2.resize(gris, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC),
            (0, 0),
            2.0,
        )


def _regiones_con_textura(gris: np.ndarray) -> list[tuple[np.ndarray, tuple[int, int]]]:
    """
    Encuentra a ojo dónde puede haber un código de barras.

    Un código —de barras o PDF417— es una zona con MUCHÍSIMAS transiciones
    verticales de negro a blanco muy juntas: bastante más densas que las de un
    texto. Se marca esa densidad con un Sobel horizontal, se la une con un
    cierre morfológico ancho y se toman los bloques que quedan.

    Es el respaldo de las zonas declaradas: sirve cuando el encuadre salió
    corrido, o cuando una emisión nueva movió el código de lugar.
    """
    alto, ancho = gris.shape[:2]
    # Trabajar sobre una versión reducida: la textura del código se detecta
    # igual y el barrido cuesta una fracción.
    escala = 900 / max(ancho, 900)
    chica = cv2.resize(gris, None, fx=escala, fy=escala) if escala < 1 else gris

    gradiente = cv2.convertScaleAbs(cv2.Sobel(chica, cv2.CV_32F, 1, 0, ksize=3))
    _, binaria = cv2.threshold(gradiente, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Kernel ancho y bajo: une barras vecinas en un bloque sin pegar renglones
    # de texto que están uno encima del otro.
    unida = cv2.morphologyEx(
        binaria, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (21, 5))
    )
    unida = cv2.morphologyEx(
        unida, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (9, 3))
    )

    contornos, _ = cv2.findContours(unida, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    factor = 1 / escala if escala < 1 else 1.0
    regiones = []
    for contorno in sorted(contornos, key=cv2.contourArea, reverse=True)[:8]:
        x, y, w, h = (int(v * factor) for v in cv2.boundingRect(contorno))
        if w < ancho * 0.08 or h < alto * 0.03:
            continue
        # Margen alrededor: un código recortado justo en el borde pierde la
        # zona tranquila que el decodificador necesita para encontrarlo.
        margen_x, margen_y = int(w * 0.12) + 8, int(h * 0.18) + 8
        x0, y0 = max(0, x - margen_x), max(0, y - margen_y)
        x1, y1 = min(ancho, x + w + margen_x), min(alto, y + h + margen_y)
        regiones.append((gris[y0:y1, x0:x1], (x0, y0)))
    return regiones


def _recortar(
    gris: np.ndarray, x0: float, y0: float, x1: float, y1: float
) -> tuple[np.ndarray | None, tuple[int, int]]:
    """Un rectángulo en proporciones → el recorte y su esquina en píxeles."""
    alto, ancho = gris.shape[:2]
    ax0, ay0 = max(0, int(x0 * ancho)), max(0, int(y0 * alto))
    ax1, ay1 = min(ancho, int(x1 * ancho)), min(alto, int(y1 * alto))
    if ax1 - ax0 < 40 or ay1 - ay0 < 25:
        return None, (0, 0)
    return gris[ay0:ay1, ax0:ax1], (ax0, ay0)


# ── Cómo decodificar ─────────────────────────────────────────────────────────


def _decodificar(
    recorte: np.ndarray,
    buscados: set[str] | None,
    etiqueta: str,
    desplazamiento: tuple[int, int],
    escala: float,
) -> list[Codigo]:
    """
    Prueba un recorte con cada preparado y cada binarizador hasta que uno lea
    algo utilizable.

    Las combinaciones están ordenadas por lo que funcionó en las pruebas: el
    recorte tal cual con el binarizador local y el global resuelven casi todo,
    y Otsu es el que cierra los casos de iluminación despareja.
    """
    import zxingcpp

    binarizadores = (
        ("local", zxingcpp.Binarizer.LocalAverage),
        ("global", zxingcpp.Binarizer.GlobalHistogram),
        ("fijo", zxingcpp.Binarizer.FixedThreshold),
    )
    # Se le dice al decodificador exactamente qué buscar en vez de dejarlo
    # probar todo: cada formato habilitado de más es una oportunidad de
    # encontrar un código que no existe sobre la guarda de seguridad.
    #
    # `formats` se OMITE cuando no hay nada que restringir, en vez de pasarlo
    # en None. La firma del binding dice que el default es None, pero pasarlo
    # explícitamente lanza TypeError; como acá abajo hay un `except` que
    # ignora la combinación fallida, eso no se veía: simplemente no se
    # encontraba ningún código nunca, sin un solo error en el log.
    concretos = _expandir(buscados)
    permitidos = _formatos_zxing(concretos)
    restriccion = {"formats": permitidos} if permitidos is not None else {}

    for nombre_preparado, preparado in _preparados(recorte):
        for nombre_binarizador, binarizador in binarizadores:
            try:
                resultados = zxingcpp.read_barcodes(
                    preparado,
                    binarizer=binarizador,
                    try_rotate=True,
                    **restriccion,
                )
            except Exception:  # noqa: BLE001 - una combinación mala no corta la búsqueda
                continue

            encontrados = []
            for resultado in resultados or []:
                formato = str(resultado.format).replace("BarcodeFormat.", "")
                if concretos and not _coincide(formato, concretos):
                    continue
                texto = (resultado.text or "").strip()
                if not _utilizable(texto):
                    continue
                encontrados.append(
                    Codigo(
                        formato=formato,
                        texto=texto,
                        esquinas=_esquinas(resultado, desplazamiento, escala),
                        variante=f"{etiqueta}+{nombre_preparado}+{nombre_binarizador}",
                    )
                )
            if encontrados:
                return encontrados
    return []


def _preparados(recorte: np.ndarray) -> Iterator[tuple[str, np.ndarray]]:
    """El recorte tal cual, con contraste realzado y binarizado con Otsu."""
    yield "crudo", recorte

    realzado = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(recorte)
    yield "contraste", realzado

    _, otsu = cv2.threshold(realzado, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    yield "otsu", otsu


def _utilizable(texto: str) -> bool:
    """
    ¿El texto decodificado sirve, o es un decodificado roto?

    Un PDF417 dañado no falla limpio: la corrección de errores lo sostiene un
    tramo y después devuelve bytes de control mezclados con el contenido real.
    Eso entra igual por la puerta del "leyó bien" y termina en campos con
    basura adentro. Los códigos de estos documentos son ASCII imprimible, así
    que cualquier carácter de control delata un decodificado roto.
    """
    if not texto or len(texto) < 4:
        return False
    return all(c == "\n" or c == "\t" or 32 <= ord(c) < 127 for c in texto)


def _expandir(buscados: set[str] | None) -> set[str] | None:
    """
    Los formatos pedidos, con "1d" reemplazado por los lineales concretos.

    Se expande UNA vez y el resultado se usa en los dos lugares que necesitan
    saber qué formatos valen: la restricción que se le pasa al decodificador y
    el filtro de lo que devuelve. Tenerlo en un solo lugar es lo que evita que
    los dos criterios se separen — que es lo que pasaba antes: el
    decodificador buscaba Code128 porque la máscara lo incluía, lo encontraba,
    y después el filtro lo descartaba porque comparaba "code128" contra "1d".
    """
    if not buscados:
        return None
    nombres: set[str] = set()
    for pedido in buscados:
        if pedido.lower() == "1d":
            nombres |= FORMATOS_1D
        else:
            nombres.add(pedido)
    return nombres


def _formatos_zxing(nombres: set[str] | None):
    """
    Los nombres de formato → la máscara de bits que entiende zxing-cpp.
    None cuando no hay nada que restringir.
    """
    import zxingcpp

    if not nombres:
        return None

    mascara = None
    for nombre in nombres:
        formato = getattr(zxingcpp.BarcodeFormat, nombre, None)
        if formato is None:
            continue
        mascara = formato if mascara is None else mascara | formato
    return mascara


def _coincide(formato: str, buscados: set[str]) -> bool:
    normalizado = formato.lower().replace("-", "").replace("_", "")
    return any(
        normalizado == b.lower().replace("-", "").replace("_", "") for b in buscados
    )


def _esquinas(
    resultado, desplazamiento: tuple[int, int], escala: float
) -> list[list[int]]:
    """
    Dónde estaba el código, en coordenadas de la imagen que se pasó.

    Hay que deshacer las dos transformaciones que se le hicieron al recorte: la
    ampliación (dividir por la escala) y el recorte en sí (sumar el
    desplazamiento). Sin esto el dato saldría en coordenadas de un recorte
    ampliado que el cliente no tiene.
    """
    posicion = getattr(resultado, "position", None)
    if posicion is None:
        return []
    dx, dy = desplazamiento
    puntos = []
    for nombre in ("top_left", "top_right", "bottom_right", "bottom_left"):
        punto = getattr(posicion, nombre, None)
        if punto is None:
            return []
        puntos.append([int(punto.x / escala) + dx, int(punto.y / escala) + dy])
    return puntos
