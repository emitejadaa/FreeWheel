"""
DORSO DEL DNI ARGENTINO.

    ┌─────────────────────────────────────────────────┐
    │ DOMICILIO: HAITI 2558 1640 1640 - MARTÍNEZ -    │
    │ SAN ISIDRO - BUENOS AIRES                       │
    │ LUGAR DE NACIMIENTO: CIUDAD DE BUENOS AIRES     │
    │                                                 │
    │   CUIL: 20-49380010-9      firma      ┌──────┐  │
    │   9CAFD3A9257B44554F73E8F0DE66F78E    │huella│  │
    │                                       └──────┘  │
    │ IDARG49380010<1<<<<<<<<<<<<<<<                  │
    │ 0904061M3808090ARG<<<<<<<<<<<8                  │
    │ TEJADA<ARAGON<<EMILIANO<<<<<<<                  │
    └─────────────────────────────────────────────────┘

DOS ORÍGENES, y acá la división es tajante:

  · ocr — el CUIL. Es el único dato de esta cara que existe ÚNICAMENTE
          impreso: no está ni en el PDF417 del frente ni en la MRZ de abajo.
          Si el OCR no lo lee, no hay otra forma de obtenerlo. El domicilio y
          el lugar de nacimiento están impresos al lado y ya no se leen: el
          domicilio del DNI casi nunca coincide con el que la persona cargó
          —se mudó, lo abrevia distinto— así que cruzarlo produce rechazos
          falsos sin detectar ningún fraude, y el lugar de nacimiento no
          decide nada. El código de control hexadecimal tampoco: solo sirve
          contra el padrón del RENAPER, que no consultamos.
  · mrz — apellido, nombre, sexo, documento, nacimiento y vencimiento, con sus
          dígitos verificadores. Es la lectura más confiable del documento
          entero, porque es la única que puede demostrar por sí sola que se
          leyó bien.

Este dorso NO tiene PDF417 ni QR: el único código del DNI está en el frente.
Los dos orígenes correspondientes se informan igual, con disponible=false, para
que la forma del JSON no cambie entre documentos.
"""

from __future__ import annotations

from .. import codigos as lector_codigos
from .. import mrz as lector_mrz
from .. import encuadre as encuadrador
from .. import normalizar, ocr
from ..contrato import Origen, campo
from . import base

# Dónde empieza la franja de la MRZ dentro del dorso encuadrado. Son VARIOS
# cortes y no uno solo, y la razón es incómoda pero real: el clasificador de
# orientación del motor de OCR es inestable con la MRZ, y de qué altura arranca
# el recorte depende que lea bien la línea del medio o que la devuelva
# invertida. Medido sobre la misma foto: 0.55 sale perfecta, 0.58 sale al revés
# y 0.60 vuelve a salir perfecta.
#
# No es algo que se pueda calibrar a un número: no hay un corte "correcto", hay
# un comportamiento que salta. La salida es probar varios y dejar que los
# dígitos verificadores elijan — ver `_de_la_mrz`.
CORTES_MRZ = (0.60, 0.55, 0.50, 0.65)

CLAVE = "dni_dorso"

# Las anclas son palabras IMPRESAS que deciden la orientación, no campos: que
# "DOMICILIO" ya no se extraiga no quita que el rótulo siga estando ahí y siga
# sirviendo para saber si la foto está cabeza abajo.
ANCLAS = (
    "DOMICILIO",
    "LUGAR DE NACIMIENTO",
    "CUIL",
    "HUELLA",
    "DACTILAR",
    "MINISTRO",
    "INTERIOR",
)

# El dorso no tiene códigos de barras. Se deja la búsqueda de QR igual, por si
# una emisión futura lo agrega: el costo de mirar es despreciable frente a
# tener que tocar el código el día que aparezca.
FORMATOS_CODIGO = ("QRCode",)

# Sin zonas declaradas: no hay ningún código que ubicar. La búsqueda cae sola
# en la imagen entera, que es más que suficiente para el caso hipotético de una
# emisión que agregue un QR.
ZONAS_CODIGO: tuple[tuple[float, float, float, float], ...] = ()

CAMPOS_OCR = (
    "cuil",
    "numero_documento",
)

# `tipo_documento` y `pais_emisor` no se cruzan contra nada: se leen porque
# tienen que decir ID y ARG, y un documento que diga otra cosa no es un DNI
# argentino por más que todo lo demás coincida.
CAMPOS_MRZ = (
    "tipo_documento",
    "pais_emisor",
    "apellido",
    "nombre",
    "sexo",
    "numero_documento",
    "fecha_nacimiento",
    "fecha_vencimiento",
)


def extraer(
    lectura: ocr.Lectura,
    codigos: list[lector_codigos.Codigo],
    marco: encuadrador.Encuadre,
) -> list[Origen]:
    return [_del_texto(lectura), _de_la_mrz(lectura, marco), _del_qr(codigos)]


def _del_texto(lectura: ocr.Lectura) -> Origen:
    """
    El CUIL, y el número de documento que sale de adentro del CUIL.

    El CUIL tiene un rótulo con dos puntos delante del valor ("CUIL: ..."),
    así que `despues_de_etiqueta` lo resuelve; el patrón queda de primera
    opción porque además se autovalida.
    """
    origen = Origen(
        nombre="ocr", disponible=True, campos=base.campos_vacios(*CAMPOS_OCR)
    )
    if not lectura:
        origen.error = "no se leyó texto en la imagen"
        return origen

    origen.ok = True

    # El CUIL se busca por forma y no por rótulo: tiene un patrón inconfundible
    # (11 dígitos con guiones) y encima un dígito verificador que dice si se
    # leyó bien. Si el patrón falla, se cae al rótulo.
    cuil_crudo, conf_cuil = lectura.primer_patron(r"\d{2}\s*-?\s*\d{7,8}\s*-?\s*\d")
    if not normalizar.cuil(cuil_crudo):
        cuil_crudo, conf_cuil = lectura.despues_de_etiqueta("CUIL")
    origen.campos["cuil"] = campo(normalizar.cuil(cuil_crudo), cuil_crudo, conf_cuil)

    # El DNI no está impreso suelto en el dorso, pero vive adentro del CUIL:
    # son sus ocho dígitos del medio. Se deriva de ahí para poder cruzarlo
    # contra el que dice la MRZ.
    cuil_normalizado = origen.campos["cuil"].valor
    if cuil_normalizado:
        derivado = cuil_normalizado.split("-")[1].lstrip("0")
        origen.campos["numero_documento"] = campo(
            derivado, f"derivado del CUIL {cuil_normalizado}", conf_cuil
        )

    origen.detalle = {
        "texto_completo": lectura.texto_completo,
        "renglones": len(lectura.renglones),
        "confianza_media": round(lectura.confianza_media, 4),
    }
    return origen


def _de_la_mrz(lectura: ocr.Lectura, marco: encuadrador.Encuadre) -> Origen:
    """
    Las tres líneas de la MRZ, con el veredicto de sus dígitos verificadores.

    LA MRZ SE LEE DE SU PROPIA FRANJA Y SE LEE VARIAS VECES.

    Leyendo el dorso entero, el motor decidió que la línea del medio iba al
    revés y la devolvió invertida y con caracteres perdidos
    —"8>>>>>>>>>>>9060808W190060" en lugar de "0904061M3808090ARG<<<<<<<<<<<8"—
    con lo cual no cerraba ni un verificador. Recortando la franja sale bien…
    pero no siempre: de qué altura arranque el recorte depende que la lea
    derecha o invertida, y sin un patrón que se pueda calibrar (ver
    CORTES_MRZ).

    Lo que salva esta situación es que LA MRZ SE PUEDE AUTOVALIDAR. Cada campo
    lleva su dígito verificador y hay uno final sobre el conjunto, así que no
    hace falta adivinar cuál lectura es la buena: se prueban varias y gana la
    que cierre la aritmética. Una lectura invertida no cierra nunca, y una
    lectura correcta cierra siempre. Se corta en la primera que cierre del
    todo; si ninguna lo hace, se devuelve la que más verificadores haya pasado.

    Por eso, además, acá la confianza no sale del motor de OCR sino de la
    aritmética: un campo cuyo verificador cierra vale 1.0 porque el documento
    mismo demuestra que se leyó bien, y uno cuyo verificador no cierra baja a
    0.5 — el dato está, pero puede tener un carácter cambiado.
    """
    origen = Origen(
        nombre="mrz", disponible=True, campos=base.campos_vacios(*CAMPOS_MRZ)
    )

    intentos: list[tuple[str, lector_mrz.ResultadoMrz]] = []
    for corte in CORTES_MRZ:
        franja = base.recorte(marco.imagen, 0.0, corte, 1.0, 1.0)
        candidato = lector_mrz.parsear(ocr.leer(franja).texto_completo)
        intentos.append((f"franja desde {corte:.2f}", candidato))
        if candidato.confiable:
            break

    # Último respaldo: el texto de toda la tarjeta. Sirve cuando el encuadre
    # quedó tan corrido que la MRZ no cae en ninguna de las franjas.
    if lectura and not any(c.confiable for _, c in intentos):
        intentos.append(("tarjeta completa", lector_mrz.parsear(lectura.texto_completo)))

    origen_lectura, datos = max(
        intentos, key=lambda par: (par[1].confiable, par[1].confianza, par[1].encontrada)
    )
    origen.detalle = {
        "lineas": datos.lineas,
        "verificadores": datos.verificadores,
        "todos_los_verificadores_cierran": datos.confiable,
        "leida_de": origen_lectura,
        "intentos": len(intentos),
    }

    if not datos.encontrada:
        origen.error = (
            datos.error
            or "no se encontraron las tres líneas de letras y símbolos < del pie"
        )
        return origen

    origen.ok = True
    verificadores = datos.verificadores

    def confianza_de(*claves: str) -> float:
        """1.0 si los verificadores que cubren este campo cerraron; 0.5 si no."""
        relevantes = [verificadores.get(clave, False) for clave in claves]
        return 1.0 if relevantes and all(relevantes) else 0.5

    for nombre_campo, valor, claves in (
        ("tipo_documento", datos.tipo_documento, ("compuesto",)),
        ("pais_emisor", datos.pais_emisor, ("compuesto",)),
        ("apellido", datos.apellido, ("compuesto",)),
        ("nombre", datos.nombre, ("compuesto",)),
        ("sexo", datos.sexo, ("compuesto",)),
        ("numero_documento", datos.numero_documento, ("numero_documento",)),
        ("fecha_nacimiento", datos.fecha_nacimiento, ("fecha_nacimiento",)),
        ("fecha_vencimiento", datos.fecha_vencimiento, ("fecha_vencimiento",)),
    ):
        origen.campos[nombre_campo] = campo(
            valor, valor, confianza_de(*claves) if valor else 0.0
        )

    return origen


def _del_qr(codigos: list[lector_codigos.Codigo]) -> Origen:
    """
    El dorso del DNI no lleva QR. Se informa igual para que los cuatro
    endpoints tengan la misma forma, con disponible=false: no es que no se
    pudo leer, es que no hay nada que leer.
    """
    origen = Origen(nombre="qr", disponible=False, campos={})
    codigo = lector_codigos.primero(codigos, "QRCode")
    if codigo is not None:
        # Una emisión que sí lo traiga: se devuelve el contenido crudo antes
        # que descartarlo, aunque todavía no se sepa cómo interpretarlo.
        origen.ok = True
        origen.detalle = {"crudo": codigo.texto, "esquinas": codigo.esquinas}
    else:
        origen.error = "el dorso del DNI no tiene código QR"
    return origen
