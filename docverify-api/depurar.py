"""
Herramienta de calibración: muestra QUÉ leyó el OCR y DÓNDE, y qué códigos
encontró el lector.

Es lo que se usa para ajustar las zonas de un extractor. Las zonas están
escritas en proporciones (0..1) sobre el documento encuadrado, así que para
corregir una hace falta ver dónde cae realmente el texto en esa imagen — que es
exactamente lo que imprime esto.

    python depurar.py dni-frente            # renglones + códigos
    python depurar.py dni-frente --guardar  # además deja el encuadre en .debug/
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2

from app import codigos as lector_codigos
from app import encuadre as encuadrador
from app import ocr
from app.documentos import REGISTRO
from app.documentos import base as analizador_base

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

RAIZ = Path(__file__).resolve().parent.parent
IMAGENES = {
    "dni-frente": RAIZ / "public" / "images" / "dni_frente.jpg",
    "dni-dorso": RAIZ / "public" / "images" / "dni_dorso.jpg",
    "licencia-frente": RAIZ / "public" / "images" / "licencia_frente.jpg",
    "licencia-dorso": RAIZ / "public" / "images" / "licencia_dorso.jpg",
}


def main() -> int:
    nombre = next((a for a in sys.argv[1:] if not a.startswith("--")), "dni-frente")
    guardar = "--guardar" in sys.argv

    analizador = REGISTRO[nombre]
    datos = IMAGENES[nombre].read_bytes()

    imagen = encuadrador.leer_imagen(datos)
    marco = encuadrador.encuadrar(imagen)
    lectura = analizador_base._orientar(marco, analizador.ANCLAS)

    print(f"\n=== {nombre} ===")
    print(
        f"encuadre: {marco.metodo} · detectado={marco.detectado}"
        f" · rotación={marco.rotacion}° · inclinación={marco.angulo:.1f}°"
    )
    print(f"\n{'x0':>6} {'y0':>6} {'x1':>6} {'y1':>6} {'conf':>5}  texto")
    print("-" * 78)
    for renglon in lectura.renglones:
        print(
            f"{renglon.x0:6.3f} {renglon.y0:6.3f} {renglon.x1:6.3f}"
            f" {renglon.y1:6.3f} {renglon.confianza:5.2f}  {renglon.texto}"
        )

    if analizador.FORMATOS_CODIGO:
        print(f"\ncódigos buscados: {', '.join(analizador.FORMATOS_CODIGO)}")
        encontrados = lector_codigos.leer_codigos(
            marco.imagen, imagen, formatos=analizador.FORMATOS_CODIGO
        )
        if not encontrados:
            print("  (ninguno)")
        for codigo in encontrados:
            print(f"  [{codigo.formato}] vía «{codigo.variante}»")
            print(f"    {codigo.texto[:300]}")

    if guardar:
        destino = Path(__file__).parent / ".debug"
        destino.mkdir(exist_ok=True)
        ruta = destino / f"{nombre}_encuadrado.jpg"
        cv2.imwrite(str(ruta), marco.imagen)
        print(f"\nencuadre guardado en {ruta}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
