"""
Limpieza e interpretación de valores crudos leídos por OCR o por código, para
convertir texto de imagen en datos con nombre. Nada de esto decide si un
campo "está bien" comparado con otra fuente — eso vive fuera de este
programa. Acá solo se normaliza forma: si no se puede interpretar, se
devuelve None y quien llama decide qué hacer con eso.
"""

from __future__ import annotations

import datetime
import re

MESES = {
    "ENE": 1, "FEB": 2, "MAR": 3, "ABR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AGO": 8, "SEP": 9, "SET": 9, "OCT": 10, "NOV": 11, "DIC": 12,
}


def normalizar_fecha(valor: str | None) -> str | None:
    """
    DD/MM/AAAA, AAAA-MM-DD, AAMMDD (los formatos que ya traían el MRZ y el
    PDF417), o "DD MES/MES AAAA" con mes abreviado en español (el formato que
    aparece impreso en el frente del DNI y en la licencia) → AAAA-MM-DD.
    """
    if not valor:
        return None
    texto = valor.strip()

    # El día es siempre numérico en estos formatos — una "O" ahí es un "0"
    # mal leído (sustituido) o un caracter de más metido por el OCR
    # (insertado) — p.ej. "0O6 ABR 2009" para "06". Se prueban las dos
    # lecturas y se toma la que da un día de 1 o 2 dígitos; se corrige solo
    # en el primer token para no tocar meses como "AGO"/"OCT", que sí llevan
    # una O real.
    partes = texto.split(None, 1)
    if len(partes) == 2:
        crudo = partes[0].upper()
        candidatos = (re.sub(r"\D", "", crudo.replace("O", "0")), re.sub(r"\D", "", crudo.replace("O", "")))
        dia_limpio = next((c for c in candidatos if 1 <= len(c) <= 2), candidatos[0])
        texto = f"{dia_limpio} {partes[1]}"

    match_mes = re.match(
        r"^(\d{1,2})\s+([A-ZÑ]{3})(?:\s*/?\s*[A-Z]{3})?\.?\s+(\d{4})$",
        texto.upper(),
    )
    if match_mes:
        dia, mes_abrev, anio = match_mes.groups()
        mes = MESES.get(mes_abrev)
        if mes is None:
            return None
        try:
            return datetime.date(int(anio), mes, int(dia)).isoformat()
        except ValueError:
            return None

    for patron, orden in (
        (r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$", "dmy"),
        (r"^(\d{4})-(\d{2})-(\d{2})$", "ymd"),
        (r"^(\d{2})(\d{2})(\d{2})$", "yymmdd"),
    ):
        match = re.match(patron, texto)
        if not match:
            continue
        if orden == "dmy":
            dia, mes, anio = match.groups()
        elif orden == "ymd":
            anio, mes, dia = match.groups()
        else:
            aa, mes, dia = match.groups()
            # Ventana de dos dígitos (convención habitual, ej. POSIX):
            # 00-68 se toma como 2000+, 69-99 como 1900+. Con el corte
            # anterior en 30, un vencimiento como "38" (2038) se leía como
            # 1938 — una fecha de vencimiento en el pasado no tiene sentido.
            anio = f"20{aa}" if int(aa) <= 68 else f"19{aa}"

        try:
            fecha = datetime.date(int(anio), int(mes), int(dia))
        except ValueError:
            return None
        return fecha.isoformat()

    return None


_CARACTER_VALIDO_NOMBRE = re.compile(r"[A-ZÑÁÉÍÓÚÜ \-']", re.IGNORECASE)


def limpiar_nombre(texto: str | None) -> str | None:
    """Recorta y colapsa espacios/saltos de línea de un nombre o apellido
    leído por OCR. Si el resultado no tiene pinta de nombre (muchos
    símbolos raros, como pasa cuando el OCR lee mal) se descarta en vez de
    devolver basura marcada como válida — más vale un campo vacío que un
    dato con el que alguien compare y confíe."""
    if not texto:
        return None
    limpio = re.sub(r"\s+", " ", texto).strip()
    if not limpio:
        return None

    validos = len(_CARACTER_VALIDO_NOMBRE.findall(limpio))
    if validos / len(limpio) < 0.85:
        return None

    return limpio


# El OCR a veces mete tildes o confunde I/1/l dentro de la etiqueta.
_ETIQUETA_DOMICILIO = re.compile(
    r"^\s*(\d\s*\.?\s*)?(DOM[IÍ1L]C[IÍ1L]L[IÍ1L]O|ADDRESS)\s*(/\s*(DOM[IÍ1L]C[IÍ1L]L[IÍ1L]O|ADDRESS))?\s*[:/]?\s*",
    re.IGNORECASE,
)


_CARACTER_VALIDO_DOMICILIO = re.compile(r"[A-ZÑÁÉÍÓÚÜ0-9 \-'.,:]", re.IGNORECASE)


def limpiar_domicilio(texto: str | None) -> str | None:
    """Recorta y colapsa espacios, saca la etiqueta ("DOMICILIO:",
    "8. Domicilio / Address", etc. — puede ir pegada al valor en el mismo
    renglón, como en el dorso del DNI, o en su propia línea dentro de la
    zona, como en la licencia) y descarta el resultado si no tiene pinta de
    domicilio (a diferencia de un nombre, un domicilio sí puede traer
    números y algunos signos, pero no el ruido típico de un OCR fallido)."""
    if not texto:
        return None
    limpio = re.sub(r"\s+", " ", texto).strip()
    if not limpio:
        return None

    limpio = _ETIQUETA_DOMICILIO.sub("", limpio).strip()
    if not limpio:
        return None

    validos = len(_CARACTER_VALIDO_DOMICILIO.findall(limpio))
    if validos / len(limpio) < 0.85:
        return None

    return limpio


def limpiar_sexo(texto: str | None) -> str | None:
    if not texto:
        return None
    letra = texto.strip().upper()[:1]
    return letra if letra in ("M", "F") else None


def limpiar_solo_digitos(texto: str | None) -> str | None:
    if not texto:
        return None
    digitos = re.sub(r"\D", "", texto)
    return digitos or None


_PESOS_CUIL = (5, 4, 3, 2, 7, 6, 5, 4, 3, 2)


def _cuil_digito_verificador_valido(digitos: str) -> bool:
    suma = sum(int(d) * peso for d, peso in zip(digitos[:10], _PESOS_CUIL))
    resto = suma % 11
    verificador = (11 - resto) % 11
    if verificador == 10:
        return False
    return verificador == int(digitos[10])


def limpiar_cuil(texto: str | None) -> str | None:
    """CUIL: 11 dígitos con dígito verificador mod-11 válido →
    "XX-XXXXXXXX-X". None si no tiene 11 dígitos o el verificador no cierra
    — un CUIL mal leído por OCR casi nunca pasa este control por azar, así
    que sirve también para detectar una foto en mala orientación."""
    digitos = limpiar_solo_digitos(texto)
    if not digitos or len(digitos) != 11:
        return None
    if not _cuil_digito_verificador_valido(digitos):
        return None
    return f"{digitos[0:2]}-{digitos[2:10]}-{digitos[10]}"
