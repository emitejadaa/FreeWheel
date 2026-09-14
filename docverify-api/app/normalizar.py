"""
DE LO QUE DICE EL DOCUMENTO A UN VALOR COMPARABLE.

Cada campo de la respuesta viaja dos veces: `crudo`, tal cual lo leyó el motor,
y `valor`, ya normalizado. Los dos hacen falta y por motivos distintos.

`valor` es para comparar por máquina: una fecha en ISO se compara con otra
fecha en ISO, sin importar que una viniera de un OCR que leyó "06 ABR/ APR
2009" y la otra de una MRZ que dice "090406". Sin normalizar, cruzar el dato
del texto contra el dato del código —que es justo el punto de leer los dos— no
se puede hacer.

`crudo` es para auditar: cuando un valor sale mal, lo único que permite saber
si el problema fue el OCR o la normalización es ver qué había antes de tocarlo.

Todas las funciones devuelven "" cuando no pueden: en la respuesta un dato que
no se detectó va vacío, nunca ausente.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date

# Los meses como los imprime el DNI argentino, que es bilingüe y abrevia:
# "06 ABR/ APR 2009". Están las dos formas, más el inglés suelto, porque el OCR
# a veces se come la barra y devuelve solo una de las dos.
MESES = {
    "ENE": 1, "JAN": 1,
    "FEB": 2,
    "MAR": 3,
    "ABR": 4, "APR": 4,
    "MAY": 5,
    "JUN": 6,
    "JUL": 7,
    "AGO": 8, "AUG": 8,
    "SEP": 9, "SET": 9,
    "OCT": 10,
    "NOV": 11,
    "DIC": 12, "DEC": 12,
}


def sin_tildes(texto: str) -> str:
    descompuesto = unicodedata.normalize("NFD", texto or "")
    return "".join(c for c in descompuesto if unicodedata.category(c) != "Mn")


def texto(valor: str) -> str:
    """
    Limpieza básica de un texto leído: espacios colapsados y sin basura en los
    bordes. No se toca el contenido —ni mayúsculas ni tildes— porque este es el
    valor que se le muestra a una persona.
    """
    if not valor:
        return ""
    limpio = re.sub(r"\s+", " ", str(valor)).strip()
    return limpio.strip(" :.-/|_")


def nombre(valor: str) -> str:
    """
    Un nombre o apellido normalizado: mayúsculas, sin tildes y sin los símbolos
    que el OCR confunde con letras en los bordes.

    Va en mayúsculas porque así está impreso en los dos documentos y porque es
    la única forma de que "Tejada Aragón" leído del OCR y "TEJADA<ARAGON" leído
    de la MRZ den el mismo valor y se puedan comparar.
    """
    limpio = texto(valor)
    if not limpio:
        return ""
    limpio = sin_tildes(limpio).upper()
    # Se conservan guion y apóstrofo: hay apellidos que los llevan.
    limpio = re.sub(r"[^A-ZÑ \-']", " ", limpio)
    return re.sub(r"\s+", " ", limpio).strip()


def numero_documento(valor: str) -> str:
    """
    El número de DNI sin puntos ni espacios: "49.380.010" → "49380010".

    Se valida el largo (6 a 9 dígitos) porque el OCR, cuando lee mal la zona,
    devuelve fragmentos de otros números —el de trámite tiene 11 dígitos— y un
    número de documento de 11 dígitos no existe.
    """
    if not valor:
        return ""
    digitos = re.sub(r"\D", "", str(valor))
    return digitos if 6 <= len(digitos) <= 9 else ""


def cuil(valor: str) -> str:
    """
    El CUIL en formato XX-XXXXXXXX-X, validando el dígito verificador.

    Se valida y no solo se formatea porque el dígito verificador es
    exactamente lo que distingue un CUIL bien leído de uno con un número
    cambiado por el OCR. Si no cierra, el dato se devuelve vacío: es preferible
    a devolver un CUIL que parece bueno y no lo es.
    """
    if not valor:
        return ""
    digitos = re.sub(r"\D", "", str(valor))
    if len(digitos) != 11:
        return ""
    if not cuil_valido(digitos):
        return ""
    return f"{digitos[:2]}-{digitos[2:10]}-{digitos[10]}"


def cuil_valido(digitos: str) -> bool:
    """
    El dígito verificador del CUIL: módulo 11 sobre los primeros diez dígitos
    con los pesos 5,4,3,2,7,6,5,4,3,2.
    """
    if len(digitos) != 11 or not digitos.isdigit():
        return False
    pesos = (5, 4, 3, 2, 7, 6, 5, 4, 3, 2)
    suma = sum(int(d) * p for d, p in zip(digitos[:10], pesos))
    resto = 11 - (suma % 11)
    if resto == 11:
        esperado = 0
    elif resto == 10:
        # El 10 no es un dígito: estos CUIL se emiten con el prefijo corregido
        # (23) y verificador 9 o 4. La regla operativa es esa sustitución.
        esperado = 9
    else:
        esperado = resto
    return int(digitos[10]) == esperado


def fecha(valor: str) -> str:
    """
    Cualquiera de las formas en que aparece una fecha en estos documentos →
    ISO AAAA-MM-DD.

    Se reconocen:
      · "06 ABR/ APR 2009"  — el DNI, bilingüe
      · "6 ABR 2009"        — la licencia
      · "28/10/2026"        — el dorso de la licencia y los códigos PDF417
      · "090406"            — la MRZ (AAMMDD, ver `fecha_mrz`)
    """
    if not valor:
        return ""
    crudo = sin_tildes(str(valor)).upper()

    # dd/mm/aaaa o dd-mm-aaaa
    encontrado = re.search(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b", crudo)
    if encontrado:
        dia, mes, anio = (int(g) for g in encontrado.groups())
        return _armar(anio, mes, dia)

    # aaaa-mm-dd (ya normalizada, o venida de un código)
    encontrado = re.search(r"\b(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\b", crudo)
    if encontrado:
        anio, mes, dia = (int(g) for g in encontrado.groups())
        return _armar(anio, mes, dia)

    # "06 ABR/ APR 2009" y variantes: el mes en letras, con o sin la traducción
    encontrado = re.search(r"\b(\d{1,2})\s*([A-Z]{3})[A-Z/\s]*?(\d{4})\b", crudo)
    if encontrado:
        dia, mes_texto, anio = encontrado.groups()
        mes = MESES.get(mes_texto)
        if mes:
            return _armar(int(anio), mes, int(dia))

    return ""


def fecha_mrz(valor: str, tipo: str = "nacimiento") -> str:
    """
    Una fecha AAMMDD de la MRZ → ISO.

    El siglo no está en el dato: la MRZ solo trae dos dígitos de año, así que
    hay que deducirlo. Y NO SE PUEDE DEDUCIR CON UNA SOLA REGLA para los dos
    campos, porque tiran para lados opuestos:

      · una fecha de NACIMIENTO no puede estar en el futuro, así que un "62"
        es 1962 y nunca 2062;
      · una fecha de VENCIMIENTO sí está en el futuro, y un "38" es 2038.

    Con una regla única —la de "más de diez años adelante es del siglo
    pasado"— el vencimiento 380809 de este DNI salía 1938-08-09: un documento
    que habría vencido hace casi un siglo. La distinción por tipo de campo es
    la que arregla eso.

    Para el vencimiento el siglo es siempre 20xx: estas MRZ aparecieron
    después del 2000, así que un documento de estos no puede vencer en 19xx.
    """
    if not valor or len(valor) != 6 or not valor.isdigit():
        return ""
    anio_corto, mes, dia = int(valor[:2]), int(valor[2:4]), int(valor[4:6])

    if tipo == "vencimiento":
        anio = 2000 + anio_corto
    else:
        anio = 2000 + anio_corto
        if anio > date.today().year:
            anio = 1900 + anio_corto

    return _armar(anio, mes, dia)


def sexo(valor: str) -> str:
    """
    El sexo como una sola letra: M, F o X.

    Se acepta la palabra entera porque hay documentos donde el OCR lee
    "MASCULINO" en vez de la letra suelta.
    """
    if not valor:
        return ""
    limpio = sin_tildes(str(valor)).upper().strip()
    if limpio.startswith("MASC") or limpio == "M":
        return "M"
    if limpio.startswith("FEM") or limpio == "F":
        return "F"
    if limpio == "X":
        return "X"
    encontrado = re.search(r"\b([MFX])\b", limpio)
    return encontrado.group(1) if encontrado else ""


def clase_licencia(valor: str) -> str:
    """
    La clase de la licencia: "B.1", "A2.2", "C". El OCR confunde el punto con
    una coma y a veces mete espacios.
    """
    if not valor:
        return ""
    limpio = sin_tildes(str(valor)).upper().replace(",", ".").replace(" ", "")
    encontrado = re.search(r"\b([A-G])\.?(\d(?:\.\d)?)?\b", limpio)
    if not encontrado:
        return ""
    letra, numero = encontrado.groups()
    return f"{letra}.{numero}" if numero else letra


def grupo_sanguineo(valor: str) -> str:
    """El grupo y factor: "0+", "A-", "AB+". Vacío si el campo trae un guion."""
    if not valor:
        return ""
    limpio = sin_tildes(str(valor)).upper().replace(" ", "")
    encontrado = re.search(r"\b(0|O|A|B|AB)\s*([+\-]|POS|NEG)", limpio)
    if not encontrado:
        return ""
    grupo, factor = encontrado.groups()
    grupo = "0" if grupo == "O" else grupo
    signo = "+" if factor in ("+", "POS") else "-"
    return f"{grupo}{signo}"


def domicilio(valor: str) -> str:
    """
    Un domicilio impreso, con los espacios que el OCR se comió.

    El dorso del DNI separa los tramos con guiones y el motor devuelve
    "HAITI2558 1640-MARTÍNEZ-SAN": pega la calle con la altura y come el
    espacio alrededor del guion. Se reponen los dos casos seguros —el borde
    entre letra y dígito, y los separadores— y nada más: cualquier heurística
    más agresiva empezaría a partir nombres de calle que van pegados de verdad.
    """
    limpio = texto(valor)
    if not limpio:
        return ""
    limpio = re.sub(r"\s*-\s*", " - ", limpio)
    limpio = re.sub(r"(?<=[A-Za-zÁÉÍÓÚÑáéíóúñ])(?=\d)", " ", limpio)
    limpio = re.sub(r"(?<=\d)(?=[A-Za-zÁÉÍÓÚÑáéíóúñ])", " ", limpio)
    return re.sub(r"\s+", " ", limpio).strip().upper()


def _armar(anio: int, mes: int, dia: int) -> str:
    """Arma la fecha ISO validando que exista de verdad (un 31/02 no pasa)."""
    if anio < 100:
        anio += 2000 if anio <= (date.today().year % 100) + 10 else 1900
    try:
        return date(anio, mes, dia).isoformat()
    except ValueError:
        return ""
