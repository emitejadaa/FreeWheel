"""
LO QUE DEVUELVE EL VERIFICADOR
==============================

Dos cosas, y nada más: la forma del resultado de cada foto y la forma de un
error. Todo lo demás del subproyecto devuelve una de las dos.

Cada foto devuelve un objeto por protocolo de extracción. Dentro de cada
objeto: `title` (el protocolo) y SIEMPRE todos los atributos extraíbles en
ese caso — con null cuando no se detectaron. El vocabulario de nombres es
único en todo el verificador, así el backend puede comparar `nombre` contra
`nombre` sin importar de qué documento ni de qué protocolo salió.

    dni_front     → { "ocr": {...}, "codigo": {...} }
    dni_back      → { "ocr": {...}, "mrz": {...} }
    license_front → { "ocr": {...} }
    license_back  → { "ocr": {...} }

Si un protocolo entero falló (sin código en la foto, MRZ que no valida,
documento sin bordes detectables) el objeto además trae `error` con el
código y el mensaje del motivo — los campos igual están, en null.
"""

from __future__ import annotations

from typing import Any


# ══════════════════════════════════════════════════════════════════════════
#  La forma de un resultado: salió bien y hay datos, o salió mal y hay un
#  motivo con código y mensaje. Nunca una excepción suelta, nunca un None
#  sin explicación.
# ══════════════════════════════════════════════════════════════════════════


def ok(**datos: Any) -> dict:
    return {"ok": True, **datos}


def error(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message}}


def desde_excepcion(code: str, exc: BaseException) -> dict:
    """Una excepción como error, con el tipo adentro del mensaje: es lo único
    que llega hasta el usuario, así que tiene que decir algo por sí solo."""
    return error(code, f"{type(exc).__name__}: {exc}")


# ══════════════════════════════════════════════════════════════════════════
#  El contrato de salida
# ══════════════════════════════════════════════════════════════════════════

# contrato: analyze.py la usa para armar la salida y los tests para
# verificarla.
CONTRATO: dict[str, dict[str, list[str]]] = {
    "dni_front": {
        "ocr": [
            "apellido",
            "nombre",
            "sexo",
            "nDocumento",
            "fechaNacimiento",
            "fechaEmision",
            "fechaVencimiento",
        ],
        "codigo": [
            "apellido",
            "nombre",
            "sexo",
            "nDocumento",
            "fechaNacimiento",
            "fechaEmision",
        ],
    },
    "dni_back": {
        "ocr": ["domicilio", "cuil"],
        "mrz": [
            "apellido",
            "nombre",
            "sexo",
            "nDocumento",
            "fechaNacimiento",
            "fechaVencimiento",
        ],
    },
    "license_front": {
        "ocr": [
            "numLicencia",
            "apellido",
            "nombre",
            "domicilio",
            "fechaNacimiento",
            "fechaVencimiento",
        ],
    },
    "license_back": {
        "ocr": ["cuil", "esPrincipiante", "finPrincipiante"],
    },
}

SLOTS = tuple(CONTRATO.keys())


def _objeto_vacio(slot: str, protocolo: str, error: dict | None = None) -> dict:
    salida: dict[str, Any] = {"title": protocolo}
    for campo in CONTRATO[slot][protocolo]:
        salida[campo] = None
    if error:
        salida["error"] = error
    return salida


def _aplanar(
    slot: str, protocolo: str, campos_ricos: dict[str, dict]
) -> dict:
    """Estructura rica {valor, ok, motivo} → contrato plano. Si TODOS los
    campos fallaron por el mismo motivo (la foto sin bordes, el MRZ que no
    valida), ese motivo compartido sube como `error` del objeto."""
    salida: dict[str, Any] = {"title": protocolo}
    motivos: set[tuple[str, str]] = set()
    algun_ok = False

    for campo in CONTRATO[slot][protocolo]:
        rico = campos_ricos.get(campo)
        if rico is None:
            salida[campo] = None
            continue
        salida[campo] = rico.get("valor") if rico.get("ok") else None
        if rico.get("ok"):
            algun_ok = True
        else:
            motivos.add((rico.get("motivo", "?"), rico.get("detalle", "")))

    if not algun_ok and len(motivos) == 1:
        code, message = next(iter(motivos))
        salida["error"] = {"code": code, "message": message}

    return salida


def armar_slot(slot: str, campos: dict, codigo: dict | None) -> dict:
    """Resultado de una foto según el contrato.

    `campos`: lo que devolvió extraccion_campos.construir_campos (ocr, mrz,
    principiante, en estructura rica). `codigo`: lo que devolvió
    codigos_barras.decodificar_pdf417_dni (solo dni_front).
    """
    resultado: dict[str, Any] = {}

    for protocolo in CONTRATO[slot]:
        if protocolo == "codigo":
            resultado[protocolo] = _objeto_codigo(slot, codigo)
        elif protocolo == "mrz":
            resultado[protocolo] = _aplanar(slot, "mrz", campos.get("mrz", {}))
        else:  # ocr — en license_back incluye la leyenda de principiante
            ricos = dict(campos.get("ocr", {}))
            ricos.update(campos.get("principiante", {}))
            resultado[protocolo] = _aplanar(slot, "ocr", ricos)

    return resultado


def _objeto_codigo(slot: str, codigo: dict | None) -> dict:
    if not codigo or not codigo.get("ok"):
        error = (codigo or {}).get("error") or {
            "code": "SIN_CODIGO",
            "message": "No se decodificó ningún código en la foto.",
        }
        return _objeto_vacio(slot, "codigo", {"code": error["code"], "message": error["message"]})

    datos = codigo["datos"]
    salida: dict[str, Any] = {"title": "codigo"}
    for campo in CONTRATO[slot]["codigo"]:
        salida[campo] = datos.get(campo)
    return salida


def slot_no_procesable(slot: str, error: dict) -> dict:
    """La imagen ni siquiera se pudo abrir: todos los objetos del contrato en
    null y el error a nivel de la foto."""
    return {
        **{protocolo: _objeto_vacio(slot, protocolo) for protocolo in CONTRATO[slot]},
        "error": {"code": error["code"], "message": error["message"]},
    }
