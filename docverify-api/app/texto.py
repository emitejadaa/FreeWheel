import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date

MESES = {
    "ENE": 1,
    "JAN": 1,
    "FEB": 2,
    "MAR": 3,
    "ABR": 4,
    "APR": 4,
    "MAY": 5,
    "JUN": 6,
    "JUL": 7,
    "AGO": 8,
    "AUG": 8,
    "SEP": 9,
    "SET": 9,
    "OCT": 10,
    "NOV": 11,
    "DIC": 12,
    "DEC": 12,
}
PESOS_CUIL = (5, 4, 3, 2, 7, 6, 5, 4, 3, 2)
VALOR_MRZ = {c: i for i, c in enumerate("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")} | {"<": 0}
A_DIGITO = str.maketrans("OQDILZSBGTA", "00011258674")
A_LETRA = str.maketrans("012586", "OIZSBG")
LARGO_MRZ = 30
PATRONES_MRZ = (
    re.compile(r"^[IAC][DC<][A-Z<]{3}[A-Z0-9<]+$"),
    re.compile(r"^\d{6}\d[MFX<]\d{6}\d[A-Z<]{3}"),
    re.compile(r"^[A-Z]+<+[A-Z<]+$"),
)


def sin_tildes(texto: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", texto) if unicodedata.category(c) != "Mn")


def nombre(valor: str) -> str:
    limpio = re.sub(r"\s+", " ", valor).strip().strip(" :.-/|_")
    limpio = re.sub(r"[^A-Z \-']", " ", sin_tildes(limpio).upper())
    return re.sub(r"\s+", " ", limpio).strip()


def numero_documento(valor: str) -> str:
    digitos = re.sub(r"\D", "", valor)
    return digitos if 6 <= len(digitos) <= 9 else ""


def cuil(valor: str) -> str:
    digitos = re.sub(r"\D", "", valor)
    if len(digitos) != 11:
        return ""
    resto = 11 - sum(int(d) * p for d, p in zip(digitos[:10], PESOS_CUIL, strict=True)) % 11
    if int(digitos[10]) != {11: 0, 10: 9}.get(resto, resto):
        return ""
    return f"{digitos[:2]}-{digitos[2:10]}-{digitos[10]}"


def dni_de_cuil(valor: str) -> str:
    return valor.split("-")[1].lstrip("0") if valor else ""


def fecha(valor: str) -> str:
    crudo = sin_tildes(valor).upper()
    if encontrada := re.search(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b", crudo):
        dia, mes, anio = map(int, encontrada.groups())
        return _fecha_iso(anio, mes, dia)
    if encontrada := re.search(r"\b(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\b", crudo):
        anio, mes, dia = map(int, encontrada.groups())
        return _fecha_iso(anio, mes, dia)
    encontrada = re.search(r"\b(\d{1,2})\s*([A-Z]{3})[A-Z/\s]*?(\d{4})\b", crudo)
    if encontrada and encontrada.group(2) in MESES:
        return _fecha_iso(int(encontrada.group(3)), MESES[encontrada.group(2)], int(encontrada.group(1)))
    return ""


def fecha_mrz(valor: str, vencimiento: bool = False) -> str:
    if len(valor) != 6 or not valor.isdigit():
        return ""
    anio, mes, dia = int(valor[:2]), int(valor[2:4]), int(valor[4:])
    siglo = 2000 if vencimiento or 2000 + anio <= date.today().year else 1900
    return _fecha_iso(siglo + anio, mes, dia)


def sexo(valor: str) -> str:
    limpio = sin_tildes(valor).upper().strip()
    if limpio.startswith("MASC"):
        return "M"
    if limpio.startswith("FEM"):
        return "F"
    encontrado = re.search(r"\b([MFX])\b", limpio)
    return encontrado.group(1) if encontrado else ""


def clase_licencia(valor: str) -> str:
    limpio = sin_tildes(valor).upper().replace(",", ".").replace(" ", "")
    encontrada = re.search(r"\b([A-G])\.?(\d(?:\.\d)?)?\b", limpio)
    if not encontrada:
        return ""
    letra, numero = encontrada.groups()
    return f"{letra}.{numero}" if numero else letra


def _fecha_iso(anio: int, mes: int, dia: int) -> str:
    if anio < 100:
        anio += 2000 if anio <= date.today().year % 100 + 10 else 1900
    try:
        return date(anio, mes, dia).isoformat()
    except ValueError:
        return ""


@dataclass
class Pdf417:
    crudo: str
    partes: list[str]
    formato: str
    campos: dict[str, str]
    error: str = ""


def pdf417(crudo: str) -> Pdf417:
    partes = [parte.strip() for parte in crudo.split("@")]
    if (campos := _pdf417_por_ancla(partes)) is not None:
        return Pdf417(crudo, partes, "arroba_anclado", campos)
    campos = _pdf417_por_forma(crudo)
    if any(campos[clave] for clave in ("numero_documento", "cuil", "fecha_nacimiento")):
        return Pdf417(crudo, partes, "por_forma", campos)
    return Pdf417(crudo, partes, "desconocido", {}, "el contenido del código no tiene un formato reconocible")


def _pdf417_por_ancla(partes: list[str]) -> dict[str, str] | None:
    if len(partes) < 6:
        return None
    for i in range(2, len(partes) - 1):
        documento = numero_documento(partes[i + 1])
        if partes[i].upper() in ("M", "F", "X") and documento:
            return {
                "apellido": nombre(partes[i - 2]),
                "nombre": nombre(partes[i - 1]),
                "sexo": sexo(partes[i]),
                "numero_documento": documento,
                "fecha_nacimiento": fecha(partes[i + 3] if i + 3 < len(partes) else ""),
                "cuil": next((valor for valor in map(cuil, partes) if valor), ""),
            }
    return None


def _pdf417_por_forma(contenido: str) -> dict[str, str]:
    encontrado = re.search(r"\b(2[0347]|1[12]|3[034])[\-\s]?\d{8}[\-\s]?\d\b", contenido)
    campos = {"cuil": cuil(encontrado.group(0)) if encontrado else ""}
    campos["numero_documento"] = dni_de_cuil(campos["cuil"])
    if not campos["numero_documento"] and (documento := re.search(r"\b\d{7,8}\b", contenido)):
        campos["numero_documento"] = numero_documento(documento.group(0))
    fechas = sorted(
        {iso for m in re.finditer(r"\b\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\b", contenido) if (iso := fecha(m.group(0)))}
    )
    campos["fecha_nacimiento"] = fechas[0] if fechas else ""
    campos["fecha_vencimiento"] = fechas[-1] if len(fechas) >= 3 else ""
    encontrado = re.search(r"@([MFX])@", contenido)
    campos["sexo"] = sexo(encontrado.group(1)) if encontrado else ""
    return campos


@dataclass
class Mrz:
    lineas: list[str] = field(default_factory=list)
    campos: dict[str, str] = field(default_factory=dict)
    verificadores: dict[str, bool] = field(default_factory=dict)

    @property
    def confiable(self) -> bool:
        return bool(self.verificadores) and all(self.verificadores.values())

    @property
    def confianza(self) -> float:
        if not self.verificadores:
            return 0.0
        return round(sum(self.verificadores.values()) / len(self.verificadores), 4)


def mrz(texto: str) -> Mrz:
    lineas = _lineas_mrz(texto)
    if not lineas:
        return Mrz()
    leida = _parsear_mrz(lineas)
    if leida.confiable:
        return leida
    corregida = _parsear_mrz(_corregir_mrz(lineas))
    return corregida if corregida.confiable else leida


def _lineas_mrz(texto: str) -> list[str]:
    candidatas = [
        linea
        for linea in map(_limpiar_linea_mrz, texto.splitlines())
        if len(linea) >= 20 and re.fullmatch(r"[A-Z0-9<]+", linea)
    ]
    if len(candidatas) == 1 and len(candidatas[0]) >= LARGO_MRZ * 3 - 3:
        candidatas = [candidatas[0][i : i + LARGO_MRZ] for i in range(0, LARGO_MRZ * 3, LARGO_MRZ)]
    encontradas: dict[int, str] = {}
    for candidata in candidatas:
        for version in (candidata, candidata[::-1]):
            ajustada = _ajustar_mrz(version)
            posicion = next(
                (i for i, patron in enumerate(PATRONES_MRZ) if i not in encontradas and patron.match(ajustada)), None
            )
            if posicion is not None:
                encontradas[posicion] = ajustada
                break
    if len(encontradas) == 3:
        return [encontradas[i] for i in range(3)]
    con_relleno = [candidata for candidata in candidatas if "<" in candidata]
    return [_ajustar_mrz(linea) for linea in con_relleno[-3:]] if len(con_relleno) >= 3 else []


def _limpiar_linea_mrz(cruda: str) -> str:
    return re.sub(r"\s+", "", re.sub(r"[«»≤≥>\uff1c\uff1e\u3008\u3009]", "<", sin_tildes(cruda).upper()))


def _ajustar_mrz(linea: str) -> str:
    return linea[:LARGO_MRZ].ljust(LARGO_MRZ, "<")


def _parsear_mrz(lineas: list[str]) -> Mrz:
    l1, l2, l3 = lineas
    apellido, _, nombres = l3.rstrip("<").partition("<<")
    return Mrz(
        lineas=lineas,
        campos={
            "tipo_documento": l1[0:2].replace("<", ""),
            "pais_emisor": l1[2:5].replace("<", ""),
            "apellido": nombre(apellido.replace("<", " ")),
            "nombre": nombre(nombres.replace("<", " ")),
            "sexo": sexo(l2[7]),
            "numero_documento": l1[5:14].replace("<", ""),
            "fecha_nacimiento": fecha_mrz(l2[0:6]),
            "fecha_vencimiento": fecha_mrz(l2[8:14], vencimiento=True),
        },
        verificadores={
            "numero_documento": _verifica(l1[5:14], l1[14]),
            "fecha_nacimiento": _verifica(l2[0:6], l2[6]),
            "fecha_vencimiento": _verifica(l2[8:14], l2[14]),
            "compuesto": _verifica(l1[5:30] + l2[0:7] + l2[8:15] + l2[18:29], l2[29]),
        },
    )


def _verifica(campo: str, digito: str) -> bool:
    return digito.isdigit() and sum(VALOR_MRZ[c] * (7, 3, 1)[i % 3] for i, c in enumerate(campo)) % 10 == int(digito)


def _corregir_mrz(lineas: list[str]) -> list[str]:
    l1, l2, l3 = lineas
    return [
        l1[:2] + l1[2:5].translate(A_LETRA) + l1[5:14] + l1[14].translate(A_DIGITO) + l1[15:],
        l2[:7].translate(A_DIGITO)
        + l2[7]
        + l2[8:15].translate(A_DIGITO)
        + l2[15:18].translate(A_LETRA)
        + l2[18:29]
        + l2[29].translate(A_DIGITO),
        l3,
    ]
