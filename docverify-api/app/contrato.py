"""
EL CONTRATO DE SALIDA: el mismo JSON siempre.

Dos reglas gobiernan esta respuesta, y las dos existen para que del otro lado
se pueda escribir código que no ramifique:

  1. LA FORMA NO CAMBIA. Los cuatro endpoints devuelven el mismo sobre, con
     las mismas claves de primer nivel. Y dentro de un documento, el juego de
     campos es SIEMPRE el mismo: el dorso del DNI devuelve sus nueve campos
     tanto si los leyó todos como si no leyó ninguno.

  2. LO QUE NO SE DETECTÓ VA VACÍO, NO AUSENTE. Un campo ilegible es
     `{"valor": "", "crudo": "", "confianza": 0.0}`. Nunca falta la clave, y
     nunca es null: quien consume no tiene que distinguir "no vino" de "vino
     vacío".

La organización es POR ORIGEN: arriba el método de lectura (ocr, pdf417, mrz,
codigo_1d, qr) y adentro los campos que ese método pudo sacar. El mismo dato
aparece en varios orígenes cuando el documento lo trae varias veces —el
apellido del dorso del DNI está impreso Y en la MRZ—, y ahí está la gracia:
compararlos entre sí es lo que permite detectar una tarjeta adulterada, donde
el texto impreso dice una cosa y el código sigue diciendo la original.

`diccionario` explica qué es cada campo, y `coincidencias` dice, para los
campos que aparecen en más de un origen, si todos dijeron lo mismo.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# 2.0.0 porque el juego de campos se recortó: quien leía "domicilio" o
# "grupo_sanguineo" ya no los va a encontrar. Ver el DICCIONARIO de abajo.
VERSION_CONTRATO = "2.0.0"

# Qué es cada dato, en una línea. Viaja en la respuesta para que no haya que
# salir a buscar la documentación para saber qué es "principiante".
#
# ESTA LISTA ES CORTA A PROPÓSITO. Los documentos traen impreso bastante más
# —nacionalidad, ejemplar, número de trámite, oficina identificadora, domicilio,
# lugar de nacimiento, código de control, jurisdicción, grupo sanguíneo,
# observaciones, el funcionario responsable— y todo eso se leía bien. Se dejó de
# leer porque un dato que no decide nada no es gratis: ocupa una zona de OCR,
# agrega un valor más que puede salir mal, y engorda un JSON que alguien tiene
# que mirar. Cada campo que quedó está por una de estas dos razones, y por
# ninguna otra:
#
#   SE CRUZA — aparece en varias caras o en varios orígenes, así que comparar
#   las lecturas entre sí detecta un documento adulterado, y compararlas contra
#   la cuenta detecta un documento que no es de quien dice ser.
#
#   HABILITA — el backend decide algo con él: si la licencia está vencida, si
#   la clase sirve para un auto, si el período de principiante sigue corriendo.
#
# Dos se sacaron además por una razón más fuerte que la utilidad: el grupo
# sanguíneo y las observaciones de la licencia son datos de SALUD, sensibles
# bajo la Ley 25.326. No hacían falta, y no tenerlos es la única forma segura de
# no filtrarlos.
DICCIONARIO: dict[str, str] = {
    # ── Se cruzan ──────────────────────────────────────────────────────────
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
    # ── Habilitan ──────────────────────────────────────────────────────────
    "fecha_vencimiento": "Fecha de vencimiento del documento (AAAA-MM-DD)",
    "fecha_otorgamiento": "Fecha de otorgamiento de la licencia (AAAA-MM-DD)",
    "clase": "Clase de licencia habilitada (B.1, A2.2, C...)",
    "es_principiante": "Si la licencia está en período de principiante (true/false)",
    "fin_principiante": "Hasta cuándo dura el período de principiante (AAAA-MM-DD)",
    # ── Dicen qué documento es ─────────────────────────────────────────────
    "tipo_documento": "Tipo de documento según la MRZ: tiene que decir ID",
    "pais_emisor": "País emisor según la MRZ: tiene que decir ARG",
}


@dataclass
class Campo:
    """Un dato leído: normalizado, crudo y con qué confianza."""

    valor: str = ""
    crudo: str = ""
    confianza: float = 0.0

    def como_json(self) -> dict:
        return {
            "valor": self.valor,
            "crudo": self.crudo,
            "confianza": round(float(self.confianza), 4),
        }


def campo(valor: str = "", crudo: str = "", confianza: float = 0.0) -> Campo:
    """
    Arma un campo cuidando la regla del contrato: si el valor normalizado
    quedó vacío, la confianza es 0 aunque el motor haya estado segurísimo de
    haber leído algo. Un valor que no pasó la normalización —un CUIL con el
    verificador mal, una fecha imposible— no es un dato con poca confianza: es
    un dato que no se pudo obtener.
    """
    valor = (valor or "").strip()
    crudo = (crudo or "").strip()
    if not valor:
        return Campo(valor="", crudo=crudo, confianza=0.0)
    return Campo(valor=valor, crudo=crudo or valor, confianza=confianza)


@dataclass
class Origen:
    """Un método de lectura y todo lo que pudo sacar del documento."""

    nombre: str
    disponible: bool
    """Si este documento TIENE esta fuente. El frente de la licencia no tiene
    código, así que su origen `pdf417` va disponible=false: no es un fallo."""

    ok: bool = False
    """Si la fuente se pudo leer."""

    error: str = ""
    """Por qué no se pudo, cuando ok es false."""

    campos: dict[str, Campo] = field(default_factory=dict)
    detalle: dict = field(default_factory=dict)
    """Lo propio de cada fuente: el contenido crudo de un código, los dígitos
    verificadores de la MRZ, el texto completo del OCR."""

    def como_json(self) -> dict:
        return {
            "ok": self.ok,
            "disponible": self.disponible,
            "error": self.error,
            "campos": {
                nombre: valor.como_json() for nombre, valor in self.campos.items()
            },
            "detalle": self.detalle,
        }


def respuesta(
    documento: str,
    encuadre: dict,
    origenes: list[Origen],
    ms: int,
) -> dict:
    """
    El sobre final. `ok` dice si se pudo leer ALGO por algún medio: un
    documento donde ninguna fuente dio un solo campo es un análisis fallido,
    aunque técnicamente no haya habido ningún error.
    """
    por_nombre = {origen.nombre: origen for origen in origenes}
    algo_leido = any(
        campo_leido.valor
        for origen in origenes
        for campo_leido in origen.campos.values()
    )

    usados = sorted(
        {nombre for origen in origenes for nombre in origen.campos},
        key=_orden_diccionario,
    )

    return {
        "ok": algo_leido,
        "documento": documento,
        "version": VERSION_CONTRATO,
        "ms": ms,
        "encuadre": encuadre,
        "diccionario": {
            nombre: DICCIONARIO.get(nombre, "") for nombre in usados
        },
        "origenes": {
            nombre: origen.como_json() for nombre, origen in por_nombre.items()
        },
        "coincidencias": _coincidencias(origenes),
    }


def _orden_diccionario(nombre: str) -> tuple[int, str]:
    """Ordena los campos como están en el diccionario: así el JSON de los
    cuatro endpoints se lee en el mismo orden y se comparan de un vistazo."""
    claves = list(DICCIONARIO)
    return (claves.index(nombre) if nombre in claves else len(claves), nombre)


def _coincidencias(origenes: list[Origen]) -> dict:
    """
    Para cada campo leído por MÁS DE UN origen, si todos dicen lo mismo.

    Es el control que justifica leer el documento por todos los medios
    disponibles: en una tarjeta adulterada el texto impreso y el código se
    contradicen, y esta comparación es lo único que lo muestra. No incluye los
    valores —ya están arriba, en cada origen— solo el veredicto y quiénes
    participaron.
    """
    lecturas: dict[str, dict[str, str]] = {}
    for origen in origenes:
        for nombre, dato in origen.campos.items():
            if dato.valor:
                lecturas.setdefault(nombre, {})[origen.nombre] = dato.valor

    resultado = {}
    for nombre, por_origen in sorted(lecturas.items(), key=lambda x: _orden_diccionario(x[0])):
        if len(por_origen) < 2:
            continue
        distintos = set(por_origen.values())
        resultado[nombre] = {
            "coinciden": len(distintos) == 1,
            "origenes": sorted(por_origen),
        }
    return resultado


def respuesta_documento(documento: str, caras: dict[str, dict], ms: int) -> dict:
    """
    LAS DOS CARAS DE UN DOCUMENTO EN UN SOLO SOBRE.

    Los endpoints por cara existen para mirar una foto sueltas; este sobre
    existe para DECIDIR, y decidir necesita las dos caras juntas. El motivo es
    que los cruces más valiosos son justamente los que cruzan de una cara a la
    otra: el apellido impreso en el frente del DNI contra el de la MRZ del
    dorso, el número de licencia del frente contra el del PDF417 del dorso. Con
    un sobre por cara, esas comparaciones no las puede hacer nadie más que
    quien tenga las dos, y armarlas del otro lado sería reimplementar acá
    afuera lo que este módulo ya sabe hacer.

    `ok` es cierto si se leyó algo en alguna cara: una cara ilegible no anula
    el documento entero, solo deja sus campos vacíos y sin cruzar.
    """
    return {
        "ok": any(cara.get("ok") for cara in caras.values()),
        "documento": documento,
        "version": VERSION_CONTRATO,
        "ms": ms,
        "diccionario": DICCIONARIO,
        "caras": caras,
        "coincidencias": coincidencias_entre_caras(caras),
    }


def coincidencias_entre_caras(caras: dict[str, dict]) -> dict:
    """
    Lo mismo que `_coincidencias` pero a través de TODO el documento: cada
    lectura se identifica como "cara.origen" ("frente.ocr", "dorso.mrz") para
    que quien mire un desacuerdo sepa exactamente qué le dijo cada quién.

    Trabaja sobre el JSON ya armado y no sobre los objetos `Origen` a propósito:
    así compara exactamente lo que se publica. Si algún día un campo se filtra
    antes de salir, esta función lo ve filtrado, que es lo correcto — comparar
    valores que el cliente no recibe sería comparar otra cosa.
    """
    lecturas: dict[str, dict[str, str]] = {}
    for nombre_cara, sobre in caras.items():
        for nombre_origen, origen in (sobre.get("origenes") or {}).items():
            for nombre_campo, dato in (origen.get("campos") or {}).items():
                valor = (dato or {}).get("valor")
                if valor:
                    lecturas.setdefault(nombre_campo, {})[
                        f"{nombre_cara}.{nombre_origen}"
                    ] = valor

    resultado = {}
    for nombre_campo, por_origen in sorted(
        lecturas.items(), key=lambda par: _orden_diccionario(par[0])
    ):
        distintos = sorted(set(por_origen.values()))
        resultado[nombre_campo] = {
            # Un solo origen no "coincide": no hay con qué compararlo. Se
            # informa igual —con `origenes` de largo 1— porque el backend
            # necesita saber que el dato existe aunque no esté corroborado.
            "coinciden": len(distintos) == 1,
            "corroborado": len(por_origen) > 1 and len(distintos) == 1,
            "valores": distintos,
            "origenes": sorted(por_origen),
            "por_origen": por_origen,
        }
    return resultado


def error_de_analisis(documento: str, mensaje: str, ms: int = 0) -> dict:
    """
    La misma forma de respuesta cuando el análisis no pudo ni empezar (la
    imagen no se pudo abrir). Mantener el sobre igual evita que el cliente
    tenga dos formas de leer un error.
    """
    return {
        "ok": False,
        "documento": documento,
        "version": VERSION_CONTRATO,
        "ms": ms,
        "encuadre": {
            "detectado": False,
            "metodo": "ninguno",
            "rotacion": 0,
            "angulo": 0.0,
            "esquinas": [],
            "tamano_original": [0, 0],
            "tamano_encuadrado": [0, 0],
        },
        "diccionario": {},
        "origenes": {},
        "coincidencias": {},
        "error": mensaje,
    }
