"""
EL CONTENIDO DE LOS PDF417 DEL DNI Y DE LA LICENCIA.

El código del frente del DNI argentino guarda los datos del titular en texto
plano separado por '@':

    00708977612@TEJADA ARAGON@EMILIANO@M@49380010@A@06/04/2009@09/08/2023@280

El del dorso de la licencia usa el mismo separador pero no el mismo orden, y
además cambió entre emisiones: hay versiones con más campos y con el número de
trámite adelante o atrás. Parsear por posición fija rompe con cada variante.

Por eso acá no se cuenta posiciones desde el principio: se busca un ANCLA. El
sexo es un campo de un solo carácter M/F seguido de un número de documento de
7-8 dígitos, y esa pareja no aparece en ninguna otra parte del código. Una vez
ubicada, todos los demás campos están a una distancia fija de ella, y eso vale
para las dos variantes.

Cuando ni siquiera el ancla aparece —una versión que no se conocía— se cae a
buscar cada dato por su forma (una fecha parece una fecha, un CUIL parece un
CUIL). Se extrae menos, pero se extrae, y el contenido crudo del código viaja
igual en la respuesta para poder ver qué vino.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import normalizar


@dataclass
class ResultadoPdf417:
    """Lo que decía el código de barras, ya separado en campos."""

    encontrado: bool = False
    crudo: str = ""
    formato_detectado: str = ""
    """arroba_anclado | arroba_posicional | por_forma | desconocido"""
    numero_tramite: str = ""
    apellido: str = ""
    nombre: str = ""
    sexo: str = ""
    numero_documento: str = ""
    ejemplar: str = ""
    fecha_nacimiento: str = ""
    fecha_emision: str = ""
    cuil: str = ""
    numero_licencia: str = ""
    clase: str = ""
    fecha_vencimiento: str = ""
    partes: list[str] = field(default_factory=list)
    error: str = ""


def parsear(crudo: str) -> ResultadoPdf417:
    """El contenido de un PDF417 → campos. Nunca lanza: informa en `error`."""
    if not crudo or not crudo.strip():
        return ResultadoPdf417(error="el código no trae contenido")

    contenido = crudo.strip()
    partes = [p.strip() for p in contenido.split("@")]

    resultado = _por_ancla(partes)
    if resultado is not None:
        resultado.crudo = contenido
        resultado.partes = partes
        return resultado

    resultado = _por_forma(contenido)
    resultado.crudo = contenido
    resultado.partes = partes
    return resultado


def _por_ancla(partes: list[str]) -> ResultadoPdf417 | None:
    """
    Ubica el par sexo + número de documento y lee los demás campos desde ahí.

    El orden alrededor del ancla es el mismo en todas las emisiones vistas:

        ... apellido, nombre, SEXO, DOCUMENTO, ejemplar, nacimiento, emisión ...
                              └─ ancla ─┘

    El número de trámite es siempre el primer elemento, y lo que sobra al final
    se ignora en vez de asumirle un significado: son campos que cambian entre
    versiones y adivinarlos daría datos inventados.
    """
    if len(partes) < 6:
        return None

    for indice, parte in enumerate(partes):
        if parte.upper() not in ("M", "F", "X"):
            continue
        if indice < 2 or indice + 1 >= len(partes):
            continue
        documento = normalizar.numero_documento(partes[indice + 1])
        if not documento:
            continue

        def en(posicion: int) -> str:
            return partes[posicion] if 0 <= posicion < len(partes) else ""

        return ResultadoPdf417(
            encontrado=True,
            formato_detectado="arroba_anclado",
            numero_tramite=re.sub(r"\D", "", partes[0]),
            apellido=normalizar.nombre(en(indice - 2)),
            nombre=normalizar.nombre(en(indice - 1)),
            sexo=normalizar.sexo(parte),
            numero_documento=documento,
            ejemplar=_ejemplar(en(indice + 2)),
            fecha_nacimiento=normalizar.fecha(en(indice + 3)),
            fecha_emision=normalizar.fecha(en(indice + 4)),
            cuil=_primer_cuil(partes),
        )
    return None


def _por_forma(contenido: str) -> ResultadoPdf417:
    """
    Sin ancla: se rescata lo que se pueda reconocer por su forma.

    Las fechas se asignan por orden cronológico y no por posición: la más
    antigua de un documento de identidad es la de nacimiento y la más nueva la
    de vencimiento. Es una suposición, pero es la única disponible cuando el
    formato del código no se conoce, y para un documento vigente se cumple.
    """
    resultado = ResultadoPdf417(encontrado=True, formato_detectado="por_forma")

    cuil_encontrado = re.search(r"\b(2[0347]|1[12]|3[034])[\-\s]?\d{8}[\-\s]?\d\b",
                                contenido)
    if cuil_encontrado:
        resultado.cuil = normalizar.cuil(cuil_encontrado.group(0))
        if resultado.cuil:
            # El DNI vive adentro del CUIL: son sus 8 dígitos del medio.
            resultado.numero_documento = resultado.cuil.split("-")[1].lstrip("0")

    if not resultado.numero_documento:
        documento = re.search(r"\b\d{7,8}\b", contenido)
        if documento:
            resultado.numero_documento = normalizar.numero_documento(documento.group(0))

    fechas = []
    for encontrada in re.finditer(r"\b\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\b", contenido):
        iso = normalizar.fecha(encontrada.group(0))
        if iso and iso not in fechas:
            fechas.append(iso)
    fechas.sort()
    if fechas:
        resultado.fecha_nacimiento = fechas[0]
    if len(fechas) >= 2:
        resultado.fecha_emision = fechas[1]
    if len(fechas) >= 3:
        resultado.fecha_vencimiento = fechas[-1]

    sexo_encontrado = re.search(r"@([MFX])@", contenido)
    if sexo_encontrado:
        resultado.sexo = normalizar.sexo(sexo_encontrado.group(1))

    if not any(
        (
            resultado.numero_documento,
            resultado.cuil,
            resultado.fecha_nacimiento,
        )
    ):
        resultado.encontrado = False
        resultado.formato_detectado = "desconocido"
        resultado.error = "el contenido del código no tiene un formato reconocible"

    return resultado


def _ejemplar(valor: str) -> str:
    """
    El ejemplar del DNI: una letra (A, B, C...) que indica la reimpresión.
    Se acepta solo una letra suelta para no confundirlo con el campo de al lado
    en una variante con otro orden.
    """
    limpio = (valor or "").strip().upper()
    return limpio if re.fullmatch(r"[A-Z]", limpio) else ""


def _primer_cuil(partes: list[str]) -> str:
    """El primer elemento que sea un CUIL válido, si el código trae alguno."""
    for parte in partes:
        candidato = normalizar.cuil(parte)
        if candidato:
            return candidato
    return ""
