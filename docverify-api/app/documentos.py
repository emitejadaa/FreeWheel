import gc
import re
import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import ClassVar

from . import texto
from .imagen import (
    FORMATOS_1D,
    Codigo,
    Encuadre,
    Lectura,
    encuadrar,
    leer_codigos,
    leer_imagen,
    leer_texto,
    orientar,
    primero,
    recortar,
)

Validador = Callable[[str], object]

VERSION = "2.0.0"
DICCIONARIO = {
    "apellido": "Apellido del titular, como figura impreso",
    "nombre": "Nombre o nombres del titular",
    "sexo": "Sexo registrado: M, F o X",
    "numero_documento": "Número de DNI, sin puntos",
    "fecha_nacimiento": "Fecha de nacimiento (AAAA-MM-DD)",
    "cuil": "CUIL del titular, en formato XX-XXXXXXXX-X y con verificador validado",
    "numero_licencia": (
        "Número de la licencia de conducir. En Argentina es el número de DNI "
        "del titular, así que tiene que coincidir con numero_documento"
    ),
    "fecha_vencimiento": "Fecha de vencimiento del documento (AAAA-MM-DD)",
    "fecha_otorgamiento": "Fecha de otorgamiento de la licencia (AAAA-MM-DD)",
    "clase": "Clase de licencia habilitada (B.1, A2.2, C...)",
    "es_principiante": "Si la licencia está en período de principiante (true/false)",
    "fin_principiante": "Hasta cuándo dura el período de principiante (AAAA-MM-DD)",
    "tipo_documento": "Tipo de documento según la MRZ: tiene que decir ID",
    "pais_emisor": "País emisor según la MRZ: tiene que decir ARG",
}
ENCUADRE_VACIO = {
    "detectado": False,
    "metodo": "ninguno",
    "rotacion": 0,
    "angulo": 0.0,
    "esquinas": [],
    "tamano_original": [0, 0],
    "tamano_encuadrado": [0, 0],
}
PATRON_CUIL = r"\d{2}\s*-?\s*\d{7,8}\s*-?\s*\d"
PATRON_FECHA = r"\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}"
CORTES_MRZ = (0.60, 0.55, 0.50, 0.65)


@dataclass
class Campo:
    valor: str = ""
    crudo: str = ""
    confianza: float = 0.0

    def como_json(self) -> dict:
        return {"valor": self.valor, "crudo": self.crudo, "confianza": round(float(self.confianza), 4)}


def campo(valor: str, crudo: str, confianza: float) -> Campo:
    valor, crudo = valor.strip(), crudo.strip()
    return Campo(valor, crudo or valor, confianza) if valor else Campo(crudo=crudo)


def _primera(lecturas: tuple[tuple[str, float], ...], valido: Validador) -> tuple[str, float]:
    return next((lectura for lectura in lecturas if valido(lectura[0])), lecturas[-1])


def _campo_valido(
    normalizar: Callable[[str], str], *lecturas: tuple[str, float], valido: Validador | None = None
) -> Campo:
    crudo, confianza = _primera(lecturas, valido or normalizar)
    return campo(normalizar(crudo), crudo, confianza)


@dataclass
class Origen:
    nombre: str
    campos: dict[str, Campo]
    disponible: bool = True
    ok: bool = False
    error: str = ""
    detalle: dict = field(default_factory=dict)

    @classmethod
    def vacio(cls, nombre: str, campos: tuple[str, ...]) -> "Origen":
        return cls(nombre, {c: Campo() for c in campos})

    def valores(self) -> dict[str, str]:
        return {nombre: dato.valor for nombre, dato in self.campos.items()}

    def como_json(self) -> dict:
        return {
            "ok": self.ok,
            "disponible": self.disponible,
            "error": self.error,
            "campos": {nombre: dato.como_json() for nombre, dato in self.campos.items()},
            "detalle": self.detalle,
        }


class Documento(ABC):
    clave: ClassVar[str]
    anclas: ClassVar[tuple[str, ...]]
    formatos: ClassVar[tuple[str, ...]]
    zonas: ClassVar[tuple[tuple[float, float, float, float], ...]] = ()
    campos: ClassVar[dict[str, tuple[str, ...]]]
    publica_texto: ClassVar[bool] = True

    @abstractmethod
    def leer(self, lectura: Lectura) -> dict[str, Campo]: ...

    @abstractmethod
    def extraer(self, lectura: Lectura, codigos: list[Codigo], marco: Encuadre) -> list[Origen]: ...

    def ocr(self, lectura: Lectura) -> Origen:
        origen = Origen.vacio("ocr", self.campos["ocr"])
        if not lectura:
            origen.error = "no se leyó texto en la imagen"
            return origen
        origen.ok = True
        origen.campos.update(self.leer(lectura))
        origen.detalle = {"texto_completo": lectura.texto_completo} if self.publica_texto else {}
        origen.detalle |= {"renglones": len(lectura.renglones), "confianza_media": round(lectura.confianza_media, 4)}
        return origen

    def pdf417(self, codigos: list[Codigo], cara: str) -> Origen:
        origen = Origen.vacio("pdf417", self.campos["pdf417"])
        codigo = primero(codigos, {"PDF417"})
        if codigo is None:
            origen.error = (
                f"no se detectó el código PDF417 del {cara}. "
                "Tiene que entrar entero en la foto, enfocado y sin reflejos encima"
            )
            return origen
        datos = texto.pdf417(codigo.texto)
        origen.detalle = {
            "crudo": datos.crudo,
            "formato_detectado": datos.formato,
            "partes": datos.partes,
            "variante_lectura": codigo.variante,
            "esquinas": codigo.esquinas,
        }
        if datos.error:
            origen.error = datos.error
            return origen
        origen.ok = True
        valores = datos.campos | {"numero_licencia": datos.campos["numero_documento"]}
        for nombre in origen.campos:
            valor = valores.get(nombre, "")
            origen.campos[nombre] = campo(valor, valor, 1.0)
        return origen


def _qr(codigos: list[Codigo], error: str) -> Origen:
    origen = Origen("qr", {}, disponible=False)
    if (codigo := primero(codigos, {"QRCode"})) is None:
        origen.error = error
    else:
        origen.ok = True
        origen.detalle = {"crudo": codigo.texto, "esquinas": codigo.esquinas}
    return origen


def _cuil(lectura: Lectura) -> dict[str, Campo]:
    campos = {
        "cuil": _campo_valido(texto.cuil, lectura.primer_patron(PATRON_CUIL), lectura.despues_de_etiqueta("CUIL"))
    }
    cuil = campos["cuil"]
    if cuil.valor:
        campos["numero_documento"] = campo(
            texto.dni_de_cuil(cuil.valor), f"derivado del CUIL {cuil.valor}", cuil.confianza
        )
    return campos


def _es_nombre(valor: str) -> str:
    limpio = texto.nombre(valor)
    return "" if len(limpio.replace(" ", "")) < 3 or any(c.isdigit() for c in valor) else limpio


class DniFrente(Documento):
    clave = "dni_frente"
    anclas = (
        "REPUBLICA ARGENTINA",
        "MERCOSUR",
        "APELLIDO",
        "SURNAME",
        "NOMBRE",
        "SEXO",
        "NACIONALIDAD",
        "EJEMPLAR",
        "DOCUMENTO",
        "TRAMITE",
        "VENCIMIENTO",
    )
    formatos = ("PDF417", "QRCode")
    zonas = ((0.48, 0.68, 0.95, 1.0),)
    campos = {
        "ocr": ("apellido", "nombre", "sexo", "numero_documento", "fecha_nacimiento", "fecha_vencimiento"),
        "pdf417": ("apellido", "nombre", "sexo", "numero_documento", "fecha_nacimiento"),
    }

    def leer(self, lectura: Lectura) -> dict[str, Campo]:
        return {
            "apellido": _campo_valido(
                texto.nombre,
                lectura.debajo_de("APELLIDO", "SURNAME"),
                lectura.texto_en_zona(0.37, 0.15, 0.85, 0.28),
                valido=bool,
            ),
            "nombre": _campo_valido(
                texto.nombre,
                lectura.debajo_de("NOMBRE", "NAME"),
                lectura.texto_en_zona(0.37, 0.30, 0.85, 0.42),
                valido=bool,
            ),
            "sexo": _campo_valido(texto.sexo, lectura.mejor_en_zona((0.26, 0.43, 0.40, 0.56), texto.sexo)),
            "fecha_nacimiento": _campo_valido(
                texto.fecha,
                lectura.debajo_de("NACIMIENTO", "DATE OF BIRTH"),
                lectura.mejor_en_zona((0.26, 0.55, 0.62, 0.65), texto.fecha),
            ),
            "fecha_vencimiento": _campo_valido(
                texto.fecha,
                lectura.debajo_de("VENCIMIENTO", "EXPIRY"),
                lectura.mejor_en_zona((0.26, 0.75, 0.62, 0.87), texto.fecha),
            ),
            "numero_documento": _campo_valido(
                texto.numero_documento,
                lectura.debajo_de("DOCUMENTO", "DOCUMENT"),
                lectura.mejor_en_zona((0.01, 0.82, 0.28, 1.0), texto.numero_documento),
            ),
        }

    def extraer(self, lectura: Lectura, codigos: list[Codigo], marco: Encuadre) -> list[Origen]:
        return [self.ocr(lectura), self.pdf417(codigos, "frente")]


class DniDorso(Documento):
    clave = "dni_dorso"
    anclas = ("DOMICILIO", "LUGAR DE NACIMIENTO", "CUIL", "HUELLA", "DACTILAR", "MINISTRO", "INTERIOR")
    formatos = ("QRCode",)
    campos = {
        "ocr": ("cuil", "numero_documento"),
        "mrz": (
            "tipo_documento",
            "pais_emisor",
            "apellido",
            "nombre",
            "sexo",
            "numero_documento",
            "fecha_nacimiento",
            "fecha_vencimiento",
        ),
    }

    def leer(self, lectura: Lectura) -> dict[str, Campo]:
        return _cuil(lectura)

    def extraer(self, lectura: Lectura, codigos: list[Codigo], marco: Encuadre) -> list[Origen]:
        return [self.ocr(lectura), self.mrz(lectura, marco), _qr(codigos, "el dorso del DNI no tiene código QR")]

    def mrz(self, lectura: Lectura, marco: Encuadre) -> Origen:
        origen = Origen.vacio("mrz", self.campos["mrz"])
        intentos: list[tuple[str, texto.Mrz]] = []
        for corte in CORTES_MRZ:
            franja, _ = recortar(marco.imagen, (0.0, corte, 1.0, 1.0))
            intentos.append((f"franja desde {corte:.2f}", texto.mrz(leer_texto(franja).texto_completo)))
            if intentos[-1][1].confiable:
                break
        if lectura and not intentos[-1][1].confiable:
            intentos.append(("tarjeta completa", texto.mrz(lectura.texto_completo)))
        leida_de, datos = max(
            intentos, key=lambda intento: (intento[1].confiable, intento[1].confianza, bool(intento[1].lineas))
        )
        origen.detalle = {
            "lineas": datos.lineas,
            "verificadores": datos.verificadores,
            "todos_los_verificadores_cierran": datos.confiable,
            "leida_de": leida_de,
            "intentos": len(intentos),
        }
        if not datos.lineas:
            origen.error = "no se encontraron las tres líneas de la MRZ"
            return origen
        origen.ok = True
        for nombre, valor in datos.campos.items():
            verificado = datos.verificadores.get(nombre, datos.verificadores["compuesto"])
            origen.campos[nombre] = campo(valor, valor, 1.0 if verificado else 0.5)
        return origen


class LicenciaFrente(Documento):
    clave = "licencia_frente"
    anclas = (
        "LICENCIA",
        "CONDUCIR",
        "APELLIDO",
        "NOMBRE",
        "DOMICILIO",
        "VENCIMIENTO",
        "OTORGAMIENTO",
        "CLASES",
        "SEGURIDAD VIAL",
    )
    formatos = ("QRCode",)
    campos = {
        "ocr": (
            "numero_licencia",
            "apellido",
            "nombre",
            "fecha_nacimiento",
            "fecha_otorgamiento",
            "fecha_vencimiento",
            "clase",
        ),
    }
    fechas = (
        ("fecha_nacimiento", ("3. FECHA", "FECHA DE NAC", "DATE OF BIRTH"), (0.20, 0.66, 0.58, 0.80)),
        ("fecha_otorgamiento", ("4A.", "OTORGAMIENTO", "DATE OF ISSUE"), (0.20, 0.78, 0.58, 0.93)),
        ("fecha_vencimiento", ("4B.", "VENCIMIENTO", "EXPIRES"), (0.55, 0.83, 1.00, 1.00)),
    )

    def leer(self, lectura: Lectura) -> dict[str, Campo]:
        campos = {
            "numero_licencia": _campo_valido(
                texto.numero_documento,
                lectura.debajo_de("LICENCIA", "LICENSE", validar=texto.numero_documento),
                lectura.mejor_en_zona((0.24, 0.16, 0.72, 0.33), texto.numero_documento),
            ),
            "apellido": _campo_valido(
                texto.nombre,
                lectura.debajo_de("APELLIDO", "LAST NAME", validar=_es_nombre),
                lectura.mejor_en_zona((0.24, 0.30, 0.78, 0.40), _es_nombre),
            ),
            "nombre": _campo_valido(
                texto.nombre,
                lectura.debajo_de("NOMBRE", "FIRST NAME", validar=_es_nombre),
                lectura.mejor_en_zona((0.24, 0.39, 0.78, 0.49), _es_nombre),
            ),
        }
        for nombre, etiquetas, zona in self.fechas:
            campos[nombre] = _campo_valido(
                texto.fecha,
                lectura.despues_de_etiqueta(*etiquetas, validar=texto.fecha),
                lectura.debajo_de(*etiquetas, validar=texto.fecha),
                lectura.mejor_en_zona(zona, texto.fecha),
            )
        campos["clase"] = _campo_valido(
            texto.clase_licencia,
            lectura.mejor_en_zona((0.72, 0.20, 1.00, 0.42), texto.clase_licencia),
            lectura.despues_de_etiqueta("CLASES", "CLASS", validar=texto.clase_licencia),
        )
        return campos

    def extraer(self, lectura: Lectura, codigos: list[Codigo], marco: Encuadre) -> list[Origen]:
        return [self.ocr(lectura), _qr(codigos, "el frente de la licencia no tiene código QR")]


class LicenciaDorso(Documento):
    clave = "licencia_dorso"
    anclas = (
        "OBSERVACIONES",
        "OBSERVATIONS",
        "GRUPO Y FACTOR",
        "BLOOD TYPE",
        "CUIL",
        "RESPONSABLE",
        "IN CHARGE",
        "AUTOMOTORES",
        "PARTICULAR",
    )
    formatos = ("PDF417", "QRCode", "1D")
    zonas = ((0.20, 0.62, 0.95, 1.00), (0.00, 0.02, 0.18, 0.72))
    campos = {
        "ocr": ("cuil", "numero_documento", "clase", "es_principiante", "fin_principiante"),
        "pdf417": (
            "apellido",
            "nombre",
            "sexo",
            "numero_documento",
            "numero_licencia",
            "cuil",
            "clase",
            "fecha_nacimiento",
            "fecha_vencimiento",
        ),
        "codigo_1d": ("numero_licencia",),
    }
    publica_texto = False

    def leer(self, lectura: Lectura) -> dict[str, Campo]:
        campos = _cuil(lectura)
        campos["clase"] = _campo_valido(
            texto.clase_licencia,
            lectura.texto_en_zona(0.58, 0.05, 0.78, 0.35),
            lectura.primer_patron(r"\b[A-G]\.?\d(?:\.\d)?\b"),
        )
        _, confianza = _primera(
            (
                lectura.despues_de_etiqueta("OBSERVATIONS", "OBSERVACIONES"),
                lectura.texto_en_zona(0.18, 0.55, 0.95, 0.75),
            ),
            bool,
        )
        texto_entero = texto.sin_tildes(lectura.texto_completo).upper()
        es_principiante = "PRINCIPIANTE" in texto_entero
        campos["es_principiante"] = campo(
            "true" if es_principiante else "false",
            "PRINCIPIANTE" if es_principiante else "sin la palabra PRINCIPIANTE",
            confianza or lectura.confianza_media,
        )
        if es_principiante:
            fin, confianza_fin = self.fin_principiante(lectura, texto_entero)
            campos["fin_principiante"] = campo(texto.fecha(fin), fin, confianza_fin)
        return campos

    @staticmethod
    def fin_principiante(lectura: Lectura, texto_entero: str) -> tuple[str, float]:
        if encontrada := re.search(rf"HASTA[^0-9]{{0,12}}({PATRON_FECHA})", texto_entero):
            return encontrada.group(1), lectura.confianza_media
        renglon = lectura.buscar("PRINCIPIANTE")
        if renglon and (encontrada := re.search(PATRON_FECHA, renglon.texto)):
            return encontrada.group(0), renglon.confianza
        return lectura.primer_patron(rf"\b{PATRON_FECHA}\b")

    def extraer(self, lectura: Lectura, codigos: list[Codigo], marco: Encuadre) -> list[Origen]:
        return [self.ocr(lectura), self.pdf417(codigos, "dorso"), self.codigo_1d(codigos)]

    def codigo_1d(self, codigos: list[Codigo]) -> Origen:
        origen = Origen.vacio("codigo_1d", self.campos["codigo_1d"])
        if (codigo := primero(codigos, FORMATOS_1D)) is None:
            origen.error = "no se detectó el código de barras lineal del borde"
            return origen
        origen.ok = True
        origen.detalle = {
            "crudo": codigo.texto,
            "formato": codigo.formato,
            "variante_lectura": codigo.variante,
            "esquinas": codigo.esquinas,
        }
        digitos = re.sub(r"\D", "", codigo.texto)
        if 7 <= len(digitos) <= 8:
            origen.campos["numero_licencia"] = campo(digitos, codigo.texto, 1.0)
        return origen


DOCUMENTOS: dict[str, Documento] = {
    "dni-frente": DniFrente(),
    "dni-dorso": DniDorso(),
    "licencia-frente": LicenciaFrente(),
    "licencia-dorso": LicenciaDorso(),
}


def analizar_cara(datos: bytes, ruta: str, lado_maximo: int) -> dict:
    documento = DOCUMENTOS[ruta]
    arranque = time.perf_counter()
    try:
        original = leer_imagen(datos, lado_maximo)
    except ValueError as error:
        return error_de_cara(documento.clave, str(error), _ms(arranque))
    marco = encuadrar(original)
    lectura = orientar(marco, documento.anclas)
    codigos = leer_codigos((marco.imagen, original), documento.formatos, documento.zonas)
    origenes = documento.extraer(lectura, codigos, marco)
    return {
        "ok": any(dato.valor for origen in origenes for dato in origen.campos.values()),
        "documento": documento.clave,
        "version": VERSION,
        "ms": _ms(arranque),
        "encuadre": marco.como_json(),
        "diccionario": {
            nombre: descripcion
            for nombre, descripcion in DICCIONARIO.items()
            if any(nombre in origen.campos for origen in origenes)
        },
        "origenes": {origen.nombre: origen.como_json() for origen in origenes},
        "coincidencias": {
            nombre: {"coinciden": len(set(lecturas.values())) == 1, "origenes": sorted(lecturas)}
            for nombre, lecturas in _lecturas({origen.nombre: origen.valores() for origen in origenes}).items()
            if len(lecturas) > 1
        },
    }


def analizar_documento(documento: str, caras: dict[str, bytes], lado_maximo: int) -> dict:
    arranque = time.perf_counter()
    sobres = {}
    for cara, datos in caras.items():
        sobres[cara] = analizar_cara(datos, f"{documento}-{cara}", lado_maximo)
        gc.collect()
    lecturas = _lecturas(
        {
            f"{cara}.{origen}": {nombre: dato["valor"] for nombre, dato in fuente["campos"].items()}
            for cara, sobre in sobres.items()
            for origen, fuente in sobre["origenes"].items()
        }
    )
    return {
        "ok": any(sobre["ok"] for sobre in sobres.values()),
        "documento": documento,
        "version": VERSION,
        "ms": _ms(arranque),
        "diccionario": DICCIONARIO,
        "caras": sobres,
        "coincidencias": {
            nombre: {
                "coinciden": len(set(por_origen.values())) == 1,
                "corroborado": len(por_origen) > 1 and len(set(por_origen.values())) == 1,
                "valores": sorted(set(por_origen.values())),
                "origenes": sorted(por_origen),
                "por_origen": por_origen,
            }
            for nombre, por_origen in lecturas.items()
        },
    }


def contrato() -> dict:
    return {
        "version": VERSION,
        "diccionario": DICCIONARIO,
        "documentos": {
            ruta: {
                "clave": documento.clave,
                "formatos_de_codigo": list(documento.formatos),
                "campos_por_origen": {origen: list(campos) for origen, campos in documento.campos.items()},
            }
            for ruta, documento in sorted(DOCUMENTOS.items())
        },
    }


def error_de_cara(documento: str, mensaje: str, ms: int = 0) -> dict:
    return {
        "ok": False,
        "documento": documento,
        "version": VERSION,
        "ms": ms,
        "encuadre": ENCUADRE_VACIO,
        "diccionario": {},
        "origenes": {},
        "coincidencias": {},
        "error": mensaje,
    }


def error_de_documento(documento: str, mensaje: str) -> dict:
    return {
        "ok": False,
        "documento": documento,
        "version": VERSION,
        "ms": 0,
        "caras": {},
        "coincidencias": {},
        "error": mensaje,
    }


def _lecturas(fuentes: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
    lecturas: dict[str, dict[str, str]] = {}
    for fuente, valores in fuentes.items():
        for nombre, valor in valores.items():
            if valor:
                lecturas.setdefault(nombre, {})[fuente] = valor
    return {nombre: lecturas[nombre] for nombre in DICCIONARIO if nombre in lecturas}


def _ms(arranque: float) -> int:
    return int((time.perf_counter() - arranque) * 1000)
