"""
Abrir la foto de un documento desde el disco, con tope de tamaño y
normalización de modo. El formato de origen (JPEG, MPO, HEIC convertido…)
deja de importar una vez decodificada: se fuerza PNG para que pytesseract no
rechace formatos que Pillow sabe abrir pero Tesseract no tiene en su lista.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

from resultado import desde_excepcion, error, ok

# Tope de la foto aceptada. Una foto de celular ronda los 3-5 MB.
MAX_IMAGE_BYTES = 15 * 1024 * 1024


def abrir_imagen_desde_archivo(ruta: str) -> dict:
    """Ruta → imagen Pillow, o el motivo por el que no se pudo."""
    archivo = Path(ruta)
    if not archivo.is_file():
        return error("ARCHIVO_INEXISTENTE", f"No existe el archivo {ruta}.")

    datos = archivo.read_bytes()
    if not datos:
        return error("IMAGEN_VACIA", "La imagen llegó con cero bytes.")
    if len(datos) > MAX_IMAGE_BYTES:
        return error(
            "IMAGEN_MUY_GRANDE",
            f"La foto pesa {len(datos) // 1024} KB y el tope es "
            f"{MAX_IMAGE_BYTES // 1024} KB.",
        )

    from PIL import Image

    try:
        imagen = Image.open(io.BytesIO(datos))
        imagen.load()
    except BaseException as exc:  # noqa: BLE001 - Pillow tira de todo
        return desde_excepcion("NO_ES_UNA_IMAGEN", exc)

    if imagen.mode not in ("RGB", "L"):
        imagen = imagen.convert("RGB")
    imagen.format = "PNG"

    return ok(imagen=imagen)


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
