"""
Corre los cuatro analizadores contra las fotos de ejemplo del repo y muestra
qué sacó cada origen.

    python probar_imagenes.py                 # las cuatro
    python probar_imagenes.py dni-dorso       # una sola
    python probar_imagenes.py --json          # el JSON completo

No levanta el servidor: llama a los analizadores directo. Es la forma más
rápida de ver si un cambio en el encuadre o en una zona mejoró o empeoró la
extracción, sin el ida y vuelta HTTP en el medio.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app.documentos import REGISTRO
from app.documentos import base as analizador_base

# La consola de Windows arranca en cp1252 y revienta con los marcos y las
# flechas que usa este informe. Se fuerza UTF-8 en vez de evitar los caracteres:
# el informe se lee mucho mejor así, y errors="replace" garantiza que igual
# imprima algo en una terminal que de verdad no los soporte.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

RAIZ = Path(__file__).resolve().parent.parent
IMAGENES = {
    "dni-frente": RAIZ / "public" / "images" / "dni_frente.jpg",
    "dni-dorso": RAIZ / "public" / "images" / "dni_dorso.jpg",
    "licencia-frente": RAIZ / "public" / "images" / "licencia_frente.jpg",
    "licencia-dorso": RAIZ / "public" / "images" / "licencia_dorso.jpg",
}

VERDE, ROJO, GRIS, APAGADO, FIN = (
    "\033[32m", "\033[31m", "\033[90m", "\033[2m", "\033[0m",
)


def main() -> int:
    argumentos = [a for a in sys.argv[1:] if not a.startswith("--")]
    como_json = "--json" in sys.argv
    pedidos = argumentos or list(IMAGENES)

    salidas = {}
    for nombre in pedidos:
        if nombre not in REGISTRO:
            print(f"{ROJO}documento desconocido: {nombre}{FIN}")
            print(f"conocidos: {', '.join(REGISTRO)}")
            return 1

        ruta = IMAGENES[nombre]
        if not ruta.exists():
            print(f"{ROJO}falta la imagen {ruta}{FIN}")
            return 1

        resultado = analizador_base.analizar(ruta.read_bytes(), REGISTRO[nombre])
        salidas[nombre] = resultado
        if not como_json:
            _mostrar(nombre, ruta, resultado)

    if como_json:
        print(json.dumps(salidas, indent=2, ensure_ascii=False))
    return 0


def _mostrar(nombre: str, ruta: Path, resultado: dict) -> None:
    encuadre = resultado["encuadre"]
    estado = f"{VERDE}ok{FIN}" if resultado["ok"] else f"{ROJO}sin datos{FIN}"
    print(f"\n{'═' * 78}")
    print(f"  {nombre.upper()}  ·  {ruta.name}  ·  {estado}  ·  {resultado['ms']} ms")
    print(f"{'═' * 78}")
    print(
        f"  encuadre: {'detectado' if encuadre['detectado'] else 'NO detectado'}"
        f" por {encuadre['metodo']}"
        f" · rotación {encuadre['rotacion']}°"
        f" · inclinación {encuadre['angulo']}°"
        f" · {encuadre['tamano_original'][0]}x{encuadre['tamano_original'][1]}"
        f" → {encuadre['tamano_encuadrado'][0]}x{encuadre['tamano_encuadrado'][1]}"
    )

    for origen_nombre, origen in resultado["origenes"].items():
        if not origen["disponible"]:
            print(f"\n  {GRIS}· {origen_nombre}: no aplica a este documento{FIN}")
            continue

        marca = f"{VERDE}✓{FIN}" if origen["ok"] else f"{ROJO}✗{FIN}"
        print(f"\n  {marca} {origen_nombre}")
        if origen["error"]:
            print(f"      {ROJO}{origen['error']}{FIN}")

        for campo_nombre, campo in origen["campos"].items():
            if campo["valor"]:
                crudo = campo["crudo"]
                extra = (
                    f"  {APAGADO}← «{crudo}»{FIN}"
                    if crudo and crudo != campo["valor"]
                    else ""
                )
                print(
                    f"      {campo_nombre:<24} {campo['valor']}"
                    f"  {GRIS}({campo['confianza']:.2f}){FIN}{extra}"
                )
            else:
                print(f"      {GRIS}{campo_nombre:<24} —{FIN}")

        if origen_nombre == "mrz" and origen["detalle"].get("lineas"):
            print(f"      {GRIS}líneas MRZ:{FIN}")
            for linea in origen["detalle"]["lineas"]:
                print(f"        {APAGADO}{linea}{FIN}")
            verificadores = origen["detalle"].get("verificadores", {})
            resumen = "  ".join(
                f"{'✓' if ok else '✗'} {clave}" for clave, ok in verificadores.items()
            )
            print(f"      {GRIS}verificadores: {resumen}{FIN}")

        if origen["detalle"].get("crudo"):
            crudo = origen["detalle"]["crudo"]
            recorte = crudo if len(crudo) <= 160 else crudo[:160] + "…"
            print(f"      {GRIS}contenido: {APAGADO}{recorte}{FIN}")

    coincidencias = resultado.get("coincidencias", {})
    if coincidencias:
        print(f"\n  {GRIS}cruce entre orígenes:{FIN}")
        for campo_nombre, dato in coincidencias.items():
            marca = f"{VERDE}=={FIN}" if dato["coinciden"] else f"{ROJO}!={FIN}"
            print(
                f"      {marca} {campo_nombre:<22}"
                f" {GRIS}{' · '.join(dato['origenes'])}{FIN}"
            )


if __name__ == "__main__":
    raise SystemExit(main())
