"""
MRZ TD1 (ICAO 9303) del dorso del DNI: tres líneas de 30 caracteres con
dígitos verificadores propios. No es un código de barras: sale del OCR, y
justamente por eso los verificadores importan — si cierran, lo que se leyó
es confiable aunque lo haya transcripto un OCR.
"""

from __future__ import annotations

import re

from normalizadores_campos import normalizar_fecha
from resultado import error, ok


def _valor_mrz(caracter: str) -> int:
    if caracter.isdigit():
        return int(caracter)
    if caracter == "<":
        return 0
    return ord(caracter) - ord("A") + 10


def digito_verificador(valor: str) -> int | None:
    """Dígito verificador ICAO con pesos 7-3-1."""
    pesos = (7, 3, 1)
    try:
        return sum(_valor_mrz(c) * pesos[i % 3] for i, c in enumerate(valor)) % 10
    except (TypeError, ValueError):
        return None


def buscar_mrz(texto: str) -> list[str]:
    """Las líneas con pinta de MRZ dentro de un texto cualquiera."""
    candidatas = []
    for linea in texto.splitlines():
        limpia = re.sub(r"\s+", "", linea.upper())
        if len(limpia) >= 25 and re.fullmatch(r"[A-Z0-9<]+", limpia):
            candidatas.append(limpia)
    return candidatas


def parsear_mrz_td1(lineas: list[str]) -> dict:
    """3 líneas TD1 → campos, con el resultado de cada dígito verificador."""
    limpias = [re.sub(r"\s+", "", l.upper()) for l in lineas if l.strip()]
    if len(limpias) != 3:
        return error(
            "MRZ_LINEAS_INCORRECTAS",
            f"Se necesitan 3 líneas del MRZ y llegaron {len(limpias)}.",
        )

    for indice, linea in enumerate(limpias, start=1):
        if len(linea) != 30:
            return error(
                "MRZ_LARGO_INCORRECTO",
                f"La línea {indice} del MRZ tiene {len(linea)} caracteres y "
                "el formato TD1 usa exactamente 30.",
            )

    l1, l2, l3 = limpias
    documento, verif_doc = l1[5:14], l1[14]
    nacimiento, verif_nac = l2[0:6], l2[6]
    sexo = l2[7]
    vencimiento, verif_vto = l2[8:14], l2[14]
    verif_compuesto = l2[29]

    compuesto = l1[5:30] + l2[0:7] + l2[8:15] + l2[18:29]
    controles = {
        "documento": digito_verificador(documento) == int(verif_doc) if verif_doc.isdigit() else False,
        "nacimiento": digito_verificador(nacimiento) == int(verif_nac) if verif_nac.isdigit() else False,
        "vencimiento": digito_verificador(vencimiento) == int(verif_vto) if verif_vto.isdigit() else False,
        "compuesto": digito_verificador(compuesto) == int(verif_compuesto) if verif_compuesto.isdigit() else False,
    }

    apellido, _, nombre = l3.partition("<<")
    return ok(
        datos={
            "apellido": apellido.replace("<", " ").strip() or None,
            "nombre": nombre.replace("<", " ").strip() or None,
            "sexo": sexo if sexo in "MF" else None,
            "nDocumento": documento.replace("<", "").lstrip("0") or None,
            "fechaNacimiento": normalizar_fecha(nacimiento),
            "fechaVencimiento": normalizar_fecha(vencimiento),
        },
        controles=controles,
        todosLosControlesCierran=all(controles.values()),
    )
