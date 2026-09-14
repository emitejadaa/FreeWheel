"""
LA MRZ DEL DORSO DEL DNI (formato TD1 de ICAO 9303).

Son las tres líneas de 30 caracteres del pie del dorso:

    IDARG49380010<1<<<<<<<<<<<<<<<
    0904061M3808090ARG<<<<<<<<<<<8
    TEJADA<ARAGON<<EMILIANO<<<<<<<

Es la fuente más confiable del documento, y no por la calidad de la impresión
sino porque TRAE SUS PROPIOS DÍGITOS VERIFICADORES: cada campo lleva un dígito
calculado sobre sus caracteres, y hay uno final sobre el conjunto. Eso permite
saber si el OCR leyó bien sin tener con qué comparar — algo que ningún otro
campo del documento permite.

La MRZ está impresa en OCR-B, una tipografía pensada para máquinas, así que el
motor la lee bien; lo que sí pasa seguido es que confunda caracteres parecidos
(0/O, 1/I, 5/S, 8/B, 2/Z). Por eso `parsear` no se rinde ante un checksum que
no cierra: prueba las sustituciones típicas en las posiciones que tienen que
ser numéricas y se queda con la combinación que cierra.

Cada campo se devuelve con su veredicto de verificador aparte, para que quien
consuma la API sepa cuáles puede dar por buenos.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import normalizar

LARGO_LINEA = 30

# La MRZ solo usa A-Z, 0-9 y el relleno '<'. Estas son las confusiones que
# comete el OCR leyendo OCR-B, y la corrección va en la dirección letra→dígito
# porque los campos que fallan (fechas, número de documento) son numéricos.
A_DIGITO = {"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1", "Z": "2",
            "S": "5", "B": "8", "G": "6", "T": "7", "A": "4"}
A_LETRA = {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G"}


@dataclass
class ResultadoMrz:
    """Lo leído de la MRZ, campo por campo, con el veredicto de cada dígito."""

    encontrada: bool = False
    lineas: list[str] = field(default_factory=list)
    tipo_documento: str = ""
    pais_emisor: str = ""
    numero_documento: str = ""
    fecha_nacimiento: str = ""
    sexo: str = ""
    fecha_vencimiento: str = ""
    nacionalidad: str = ""
    apellido: str = ""
    nombre: str = ""
    verificadores: dict[str, bool] = field(default_factory=dict)
    error: str = ""

    @property
    def confiable(self) -> bool:
        """
        Si TODOS los dígitos verificadores cierran. Cuando es true, lo que dice
        la MRZ vale más que cualquier otra lectura del documento.
        """
        return bool(self.verificadores) and all(self.verificadores.values())

    @property
    def confianza(self) -> float:
        """La proporción de verificadores que cerraron, como confianza 0..1."""
        if not self.verificadores:
            return 0.0
        return round(
            sum(1 for ok in self.verificadores.values() if ok)
            / len(self.verificadores),
            4,
        )


def parsear(texto_ocr: str) -> ResultadoMrz:
    """
    Encuentra las tres líneas de la MRZ dentro del texto del OCR y las parsea.

    Recibe el texto entero del dorso, no un recorte: ubicar la MRZ por su forma
    (tres renglones de 30 caracteres del alfabeto MRZ) es más confiable que
    recortar la franja de abajo y esperar que caiga justo.
    """
    lineas = _buscar_lineas(texto_ocr)
    if not lineas:
        return ResultadoMrz(error="no se encontraron las tres líneas de la MRZ")

    resultado = _parsear_lineas(lineas)
    if resultado.confiable:
        return resultado

    # Algún verificador no cerró: se prueban las confusiones típicas del OCR en
    # las posiciones numéricas. Si alguna combinación hace cerrar TODO, esa es
    # la lectura correcta — un checksum que cierra por casualidad después de
    # corregir caracteres es improbable.
    corregido = _intentar_correccion(lineas)
    if corregido and corregido.confiable:
        return corregido

    return resultado


# Cómo se reconoce cada una de las tres líneas por su forma. Es lo que permite
# identificarlas SIN depender de que vengan en orden ni de que sean las últimas
# tres del documento.
PATRON_L1 = re.compile(r"^[IAC][DC<][A-Z<]{3}[A-Z0-9<]+$")
PATRON_L2 = re.compile(r"^\d{6}\d[MFX<]\d{6}\d[A-Z<]{3}")
PATRON_L3 = re.compile(r"^[A-Z]+<+[A-Z<]+$")


def _buscar_lineas(texto: str) -> list[str]:
    """
    Las tres líneas de la MRZ dentro del texto suelto del OCR.

    Se identifican POR SU FORMA y no por su posición, y cada una se prueba
    también DADA VUELTA. Las dos cosas hacen falta por lo mismo: el OCR no
    entrega la MRZ ordenada y limpia.

    · Por forma, porque abajo del CUIL el DNI tiene impresa una cadena
      hexadecimal de 32 caracteres —"9CAFD3A9257B44554F73E8F0DE66F78E"— que es
      mayúsculas y dígitos igual que una línea de MRZ. Tomando "las últimas
      tres líneas que parezcan MRZ" esa cadena entraba como primera línea, y
      con eso todo el parseo salía corrido.

    · Dada vuelta, porque el clasificador de orientación del motor da vuelta
      renglones de OCR-B con cierta frecuencia, y una línea invertida no falla
      ruidosamente: produce datos plausibles y mal.
    """
    candidatas: list[str] = []
    for cruda in (texto or "").splitlines():
        limpia = _normalizar_linea(cruda)
        if len(limpia) < 20 or not re.fullmatch(r"[A-Z0-9<]+", limpia):
            continue
        candidatas.append(limpia)

    # Caso "las tres vinieron pegadas": 90 caracteres seguidos se parten en 3.
    if len(candidatas) == 1 and len(candidatas[0]) >= LARGO_LINEA * 3 - 3:
        junto = candidatas[0]
        candidatas = [junto[i : i + LARGO_LINEA] for i in range(0, 90, LARGO_LINEA)]

    encontradas: dict[int, str] = {}
    for candidata in candidatas:
        for version in (candidata, candidata[::-1]):
            ajustada = _ajustar_largo(version)
            for posicion, patron in ((0, PATRON_L1), (1, PATRON_L2), (2, PATRON_L3)):
                if posicion not in encontradas and patron.match(ajustada):
                    encontradas[posicion] = ajustada
                    break
            else:
                continue
            break

    if len(encontradas) == 3:
        return [encontradas[0], encontradas[1], encontradas[2]]

    # Ninguna forma cerró: se cae a las últimas tres que tengan relleno '<',
    # que es lo que separa una línea de MRZ de cualquier otro texto en
    # mayúsculas del documento.
    con_relleno = [c for c in candidatas if "<" in c]
    if len(con_relleno) >= 3:
        return [_ajustar_largo(l) for l in con_relleno[-3:]]
    return []


def _normalizar_linea(cruda: str) -> str:
    """
    Pasa a mayúsculas y unifica todo lo que el OCR usa en lugar de '<'.

    El '>' entra en la lista porque es lo que devuelve el motor cuando lee un
    renglón al revés: el relleno '<<<<' invertido le sale '>>>>'. Unificarlo
    acá es lo que permite después reconocer la línea dándola vuelta.
    """
    limpia = normalizar.sin_tildes(cruda or "").upper()
    limpia = limpia.replace("«", "<").replace("»", "<")
    limpia = re.sub(r"[≤＜〈>≥＞〉]", "<", limpia)
    # El relleno son '<' consecutivos; el OCR mete espacios entre ellos.
    limpia = re.sub(r"\s+", "", limpia)
    return limpia


def _ajustar_largo(linea: str) -> str:
    """Una línea TD1 mide 30: se rellena con '<' o se recorta el sobrante."""
    return linea[:LARGO_LINEA].ljust(LARGO_LINEA, "<")


def _parsear_lineas(lineas: list[str]) -> ResultadoMrz:
    """
    Las tres líneas → campos, según las posiciones fijas de la TD1.

    Línea 1: tipo(0:2) país(2:5) nro_documento(5:14) verificador(14) resto
    Línea 2: nacimiento(0:6) v(6) sexo(7) vencimiento(8:14) v(14)
             nacionalidad(15:18) ... verificador_compuesto(29)
    Línea 3: APELLIDO<<NOMBRES, con '<' como separador de palabras
    """
    l1, l2, l3 = lineas

    numero_crudo = l1[5:14]
    verificador_numero = l1[14]
    nacimiento_crudo = l2[0:6]
    verificador_nacimiento = l2[6]
    vencimiento_crudo = l2[8:14]
    verificador_vencimiento = l2[14]
    verificador_final = l2[29]

    # El verificador compuesto de la TD1 se calcula sobre estos tramos, en
    # este orden: es lo que ata las dos primeras líneas entre sí y detecta que
    # alguien cambió un campo suelto.
    compuesto = l1[5:30] + l2[0:7] + l2[8:15] + l2[18:29]

    apellido, nombre = _partir_nombre(l3)

    return ResultadoMrz(
        encontrada=True,
        lineas=lineas,
        tipo_documento=l1[0:2].replace("<", ""),
        pais_emisor=l1[2:5].replace("<", ""),
        numero_documento=numero_crudo.replace("<", ""),
        fecha_nacimiento=normalizar.fecha_mrz(nacimiento_crudo, "nacimiento"),
        sexo=normalizar.sexo(l2[7]),
        fecha_vencimiento=normalizar.fecha_mrz(vencimiento_crudo, "vencimiento"),
        nacionalidad=l2[15:18].replace("<", ""),
        apellido=apellido,
        nombre=nombre,
        verificadores={
            "numero_documento": _verifica(numero_crudo, verificador_numero),
            "fecha_nacimiento": _verifica(nacimiento_crudo, verificador_nacimiento),
            "fecha_vencimiento": _verifica(vencimiento_crudo, verificador_vencimiento),
            "compuesto": _verifica(compuesto, verificador_final),
        },
    )


def _partir_nombre(linea: str) -> tuple[str, str]:
    """
    La línea 3 en apellido y nombres. El separador es '<<'; dentro de cada
    parte, un '<' simple separa palabras (un apellido compuesto).
    """
    limpia = linea.rstrip("<")
    if "<<" in limpia:
        apellido_crudo, nombre_crudo = limpia.split("<<", 1)
    else:
        apellido_crudo, nombre_crudo = limpia, ""
    apellido = normalizar.nombre(apellido_crudo.replace("<", " "))
    nombre = normalizar.nombre(nombre_crudo.replace("<", " "))
    return apellido, nombre


def _verifica(campo: str, digito: str) -> bool:
    """¿El dígito verificador declarado coincide con el calculado?"""
    if not digito.isdigit():
        return False
    return _checksum(campo) == int(digito)


def _checksum(campo: str) -> int:
    """
    El algoritmo de ICAO 9303: pesos 7-3-1 que se repiten, dígitos por su
    valor, letras por su posición en el alfabeto + 10, y '<' como cero. La
    suma se toma módulo 10.
    """
    pesos = (7, 3, 1)
    total = 0
    for indice, caracter in enumerate(campo):
        if caracter.isdigit():
            valor = int(caracter)
        elif caracter.isalpha():
            valor = ord(caracter) - ord("A") + 10
        elif caracter == "<":
            valor = 0
        else:
            return -1  # un carácter que no pertenece a la MRZ: no puede cerrar
        total += valor * pesos[indice % 3]
    return total % 10


def _intentar_correccion(lineas: list[str]) -> ResultadoMrz | None:
    """
    Corrige las confusiones del OCR en las posiciones que deben ser numéricas y
    se queda con la lectura cuyos verificadores cierren.

    Se corrige por POSICIÓN y no por contenido: en la TD1 se sabe de antemano
    qué posiciones son dígitos (las fechas, los verificadores) y cuáles letras
    (el país, la nacionalidad). Aplicar la sustitución solo donde corresponde
    evita romper un campo que estaba bien leído.
    """
    l1, l2, l3 = lineas

    # Línea 1: el país es alfabético; el verificador, numérico.
    l1 = l1[:2] + _forzar_letras(l1[2:5]) + l1[5:14] + _forzar_digitos(l1[14]) + l1[15:]
    # Línea 2: las dos fechas y sus verificadores son numéricos, igual que el
    # compuesto del final; la nacionalidad es alfabética.
    l2 = (
        _forzar_digitos(l2[0:7])
        + l2[7]
        + _forzar_digitos(l2[8:15])
        + _forzar_letras(l2[15:18])
        + l2[18:29]
        + _forzar_digitos(l2[29])
    )

    corregido = _parsear_lineas([l1, l2, l3])
    return corregido if corregido.encontrada else None


def _forzar_digitos(tramo: str) -> str:
    return "".join(A_DIGITO.get(c, c) for c in tramo)


def _forzar_letras(tramo: str) -> str:
    return "".join(A_LETRA.get(c, c) for c in tramo)
