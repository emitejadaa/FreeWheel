"""
Dónde está cada campo en la tarjeta ya rectificada (bordes derechos,
orientación de lectura correcta), como fracción (0.0-1.0) del ancho y el
alto. Son puntos de partida calibrados a ojo contra las fotos reales de
testDocuments/ — se ajustan acá mismo si algún recorte no cae sobre el
texto correcto.
"""

from __future__ import annotations

# (x0, y0, x1, y1), fracción del ancho/alto del rectángulo ya derecho.
ZONAS: dict[str, dict[str, tuple[float, float, float, float]]] = {
    "dni_front": {
        "apellido":         (0.36, 0.18, 1.00, 0.28),
        "nombre":           (0.36, 0.31, 1.00, 0.41),
        "sexo":             (0.36, 0.44, 0.46, 0.53),
        "fechaNacimiento":  (0.36, 0.54, 0.75, 0.63),
        "fechaEmision":     (0.36, 0.64, 0.75, 0.73),
        "fechaVencimiento": (0.36, 0.74, 0.75, 0.84),
        "nDocumento":       (0.00, 0.85, 0.33, 1.00),
    },
    "dni_back": {
        "domicilio": (0.02, 0.04, 0.72, 0.18),
        "cuil":      (0.02, 0.52, 0.40, 0.62),
    },
    "license_front": {
        "numLicencia":      (0.36, 0.22, 0.60, 0.34),
        "apellido":         (0.36, 0.36, 0.80, 0.49),
        "nombre":           (0.38, 0.51, 0.65, 0.60),
        "domicilio":        (0.36, 0.59, 0.92, 0.79),
        "fechaNacimiento":  (0.34, 0.79, 0.62, 0.94),
        "fechaVencimiento": (0.62, 0.87, 0.98, 1.00),
    },
    # El dorso de la licencia no usa zonas: el CUIL y la leyenda de
    # principiante se buscan en el texto completo (extraccion_campos), porque
    # su posición varía entre jurisdicciones y el CUIL trae su propio dígito
    # verificador para validar la lectura.
}

# Franja del MRZ (dorso del DNI): tres líneas, se OCR-ea como bloque único y
# se parsea con buscar_mrz / parsear_mrz_td1 — no campo por campo, porque el
# MRZ se interpreta por posición de caracter dentro de la línea, no por
# ubicación visual.
ZONA_MRZ_DNI_DORSO: tuple[float, float, float, float] = (0.02, 0.68, 1.00, 1.00)


def zona_a_pixeles(
    zona: tuple[float, float, float, float],
    ancho: int,
    alto: int,
    padding: float = 0.02,
) -> tuple[int, int, int, int]:
    """Convierte una zona fraccionaria a un recorte en píxeles, con margen."""
    x0, y0, x1, y1 = zona
    pad_x = (x1 - x0) * padding
    pad_y = (y1 - y0) * padding
    x0 = max(0.0, x0 - pad_x)
    y0 = max(0.0, y0 - pad_y)
    x1 = min(1.0, x1 + pad_x)
    y1 = min(1.0, y1 + pad_y)
    return (int(x0 * ancho), int(y0 * alto), int(x1 * ancho), int(y1 * alto))
