"""
Decodificación del PDF417 del DNI argentino con zxing-cpp, probando varias
variantes de la imagen, y su interpretación al vocabulario de campos.

El PDF417 de la tarjeta 2012+ del RENAPER viene separado por @:

    nroTramite@APELLIDO@NOMBRE@SEXO@DNI@EJEMPLAR@DD/MM/AAAA@DD/MM/AAAA

Hay variantes que agregan campos al final, así que se exigen los ocho
primeros y el resto se ignora.
"""

from __future__ import annotations

import re
from typing import Any

from imagenes import generar_variantes
from normalizadores_campos import normalizar_fecha
from resultado import error, ok


def _formatos_zxing(nombres: list[str]) -> Any:
    """Máscara de formatos tolerando diferencias entre versiones de zxing-cpp
    (algunas escriben PDF417 y otras PDF_417)."""
    import zxingcpp

    combinado = None
    for nombre in nombres:
        for candidato in (nombre, nombre.replace("PDF417", "PDF_417"), nombre.upper()):
            formato = getattr(zxingcpp.BarcodeFormat, candidato, None)
            if formato is not None:
                combinado = formato if combinado is None else (combinado | formato)
                break
    return combinado


_PARAMETROS_ZXING: set[str] | None = None


def _parametros_de_read_barcodes() -> set[str]:
    """Qué parámetros acepta read_barcodes en ESTA versión. inspect.signature
    no sirve (extensión C++): el nombre real de cada parámetro está en la
    primera línea del docstring que genera pybind11."""
    import zxingcpp

    doc = getattr(zxingcpp.read_barcodes, "__doc__", "") or ""
    primera = doc.splitlines()[0] if doc else ""
    return set(re.findall(r"(\w+)\s*:", primera))


def _leer_con_zxing(imagen: Any, formatos: Any) -> list[Any]:
    """Llama a read_barcodes con las opciones que esa versión conoce."""
    import zxingcpp

    global _PARAMETROS_ZXING
    if _PARAMETROS_ZXING is None:
        _PARAMETROS_ZXING = _parametros_de_read_barcodes()

    deseados: dict[str, Any] = {
        "try_rotate": True,
        "try_downscale": True,
        "try_invert": True,
    }
    if formatos is not None:
        deseados["formats"] = formatos

    kwargs = (
        {k: v for k, v in deseados.items() if k in _PARAMETROS_ZXING}
        if _PARAMETROS_ZXING
        else {}
    )

    try:
        return list(zxingcpp.read_barcodes(imagen, **kwargs))
    except TypeError:
        if formatos is not None:
            try:
                return list(zxingcpp.read_barcodes(imagen, formats=formatos))
            except TypeError:
                pass
        return list(zxingcpp.read_barcodes(imagen))


def decodificar_pdf417_dni(imagen: Any) -> dict:
    """Busca el PDF417 del DNI en cada variante de la imagen y lo interpreta.
    Devuelve ok(datos=...) con el vocabulario de campos, o el motivo."""
    formatos = _formatos_zxing(["PDF417"])

    detectado_ilegible = False
    ultimo_error: dict | None = None

    for _nombre, variante in generar_variantes(imagen):
        try:
            resultados = _leer_con_zxing(variante, formatos)
        except BaseException:  # noqa: BLE001 - una variante rota no corta el resto
            continue

        for resultado in resultados:
            texto = getattr(resultado, "text", "") or ""
            valido = getattr(resultado, "valid", True)
            if not texto or not valido:
                detectado_ilegible = True
                continue

            interpretado = parsear_pdf417_dni(texto)
            if interpretado["ok"]:
                return interpretado
            ultimo_error = interpretado

    if ultimo_error is not None:
        return ultimo_error
    if detectado_ilegible:
        return error(
            "CODIGO_DETECTADO_PERO_ILEGIBLE",
            "Se detectó un código de barras en la foto pero no se pudo "
            "decodificar: falta calidad (resolución, foco o reflejo).",
        )
    return error(
        "SIN_CODIGO",
        "No apareció ningún código PDF417 en la foto en ninguna de las "
        "variantes probadas.",
    )


def parsear_pdf417_dni(payload: str) -> dict:
    """Payload crudo del PDF417 → campos con el vocabulario compartido."""
    campos = payload.strip().split("@")
    if len(campos) < 2:
        return error(
            "CODIGO_NO_ES_DNI",
            "El código leído no tiene la forma del PDF417 del RENAPER "
            "(campos separados por @).",
        )
    if len(campos) < 8:
        return error(
            "CODIGO_INCOMPLETO",
            f"El PDF417 trae {len(campos)} campos y el formato del RENAPER "
            "tiene al menos 8: se leyó a medias.",
        )

    dni = re.sub(r"\D", "", campos[4] or "").lstrip("0")
    if not 7 <= len(dni) <= 8:
        return error(
            "CODIGO_SIN_DOCUMENTO",
            f'El campo del número de documento dice "{campos[4]}" y no '
            "parece un DNI argentino (7 u 8 dígitos).",
        )

    nacimiento = normalizar_fecha(campos[6])
    if not nacimiento:
        return error(
            "CODIGO_SIN_NACIMIENTO",
            f'La fecha de nacimiento del código dice "{campos[6]}" y no se '
            "pudo interpretar.",
        )

    apellido = campos[1].strip() or None
    nombre = campos[2].strip() or None
    if not apellido or not nombre:
        return error(
            "CODIGO_SIN_NOMBRES",
            "El PDF417 tiene la forma correcta pero viene sin apellido o "
            "sin nombre.",
        )

    sexo = (campos[3] or "").strip().upper()[:1]
    return ok(
        datos={
            "apellido": apellido,
            "nombre": nombre,
            "sexo": sexo if sexo in ("M", "F") else None,
            "nDocumento": dni,
            "fechaNacimiento": nacimiento,
            "fechaEmision": normalizar_fecha(campos[7]),
        }
    )
