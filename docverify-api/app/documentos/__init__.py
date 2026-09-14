"""
Los cuatro documentos que la API sabe analizar.

Uno por CARA y no uno por documento: el frente y el dorso de un mismo DNI no
comparten nada del procedimiento de lectura —el frente tiene PDF417 y el dorso
MRZ, y hasta los campos son distintos—, así que tratarlos como un solo analizador
sería juntar dos cosas que no se parecen.
"""

from . import dni_dorso, dni_frente, licencia_dorso, licencia_frente

# La ruta de cada documento → su analizador. Es lo que recorre el router para
# publicar los endpoints, así que agregar un documento nuevo es agregar un
# módulo y una línea acá.
REGISTRO = {
    "dni-frente": dni_frente,
    "dni-dorso": dni_dorso,
    "licencia-frente": licencia_frente,
    "licencia-dorso": licencia_dorso,
}

__all__ = ["REGISTRO", "dni_frente", "dni_dorso", "licencia_frente", "licencia_dorso"]
