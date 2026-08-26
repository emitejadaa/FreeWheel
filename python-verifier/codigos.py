"""
LOS PROTOCOLOS QUE SE VALIDAN SOLOS
===================================

Los dos únicos datos del documento que se pueden verificar mecánicamente, y
por eso el backend los exige:

  · PDF417 — el código de barras del frente del DNI. Se decodifica con
    zxing-cpp; o sale entero o no sale.
  · MRZ TD1 — las tres líneas del dorso (ICAO 9303). Esto SÍ sale del OCR, y
    justamente por eso importan sus dígitos verificadores: si cierran, lo que
    se leyó es confiable aunque lo haya transcripto un OCR.

El PDF417 de la tarjeta 2012+ del RENAPER viene separado por @:

    nroTramite@APELLIDO@NOMBRE@SEXO@DNI@EJEMPLAR@DD/MM/AAAA@DD/MM/AAAA

Hay variantes que agregan campos al final, así que se exigen los ocho
primeros y el resto se ignora.
"""

from __future__ import annotations

import re
from typing import Any

from contrato import error, ok
from normalizadores import normalizar_fecha


# ══════════════════════════════════════════════════════════════════════════
#  PDF417 del frente del DNI
# ══════════════════════════════════════════════════════════════════════════


def generar_variantes(imagen: Any, lado_maximo: int = 2000) -> list[tuple[str, Any]]:
    """Variantes de la foto para buscar el código de barras: si no se lee tal
    cual vino, se prueba reducida/ampliada, en grises, binarizada, invertida
    y rotada."""
    from PIL import Image, ImageOps

    variantes: list[tuple[str, Any]] = [("original", imagen)]

    lado = max(imagen.width, imagen.height)
    if lado > lado_maximo:
        escala = lado_maximo / lado
        variantes.append(
            (
                f"reducida a {lado_maximo}px",
                imagen.resize(
                    (max(1, int(imagen.width * escala)), max(1, int(imagen.height * escala))),
                    Image.LANCZOS,
                ),
            )
        )
    elif lado < 1200:
        # Una foto chica puede necesitar MÁS resolución para que las barras
        # finas del PDF417 se separen.
        variantes.append(
            ("ampliada al doble", imagen.resize((imagen.width * 2, imagen.height * 2), Image.LANCZOS))
        )

    grises = ImageOps.grayscale(imagen)
    variantes.append(("grises + autocontraste", ImageOps.autocontrast(grises)))
    variantes.append(("blanco y negro", grises.point(lambda v: 255 if v >= 128 else 0, mode="L")))
    variantes.append(("invertida", ImageOps.invert(grises)))
    variantes.append(("rotada 90°", imagen.rotate(90, expand=True)))

    return variantes


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


# ══════════════════════════════════════════════════════════════════════════
#  MRZ TD1 del dorso del DNI
# ══════════════════════════════════════════════════════════════════════════


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
