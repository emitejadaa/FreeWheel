# Imagen de la API de verificación documental.
#
# Es un Dockerfile corto porque no hay nada del sistema que instalar: el OCR
# corre sobre ONNX Runtime y el lector de códigos es zxing-cpp, los dos con
# wheels de pip. Nada de tesseract-ocr ni libzbar por apt.
#
# "slim" y no "alpine": las wheels de numpy, opencv y onnxruntime son para
# glibc (manylinux), y en Alpine (musl) habría que compilarlas.
FROM python:3.13-slim

LABEL org.opencontainers.image.title="docverify-api" \
      org.opencontainers.image.description="API de verificación documental (DNI y licencia de conducir argentinos)" \
      org.opencontainers.image.source="https://github.com/emitejadaa/FreeWheel"

# PYTHONUNBUFFERED: sin esto Python bufferea stdout cuando no hay una terminal
# del otro lado, que es exactamente el caso dentro de un contenedor. El
# resultado es que `docker logs` no muestra nada hasta que se llena el buffer —
# y quien está diagnosticando un arranque fallido concluye que el proceso está
# colgado cuando en realidad ya escribió el error.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# libgl/libglib: opencv-python-headless igual enlaza contra un par de
# bibliotecas gráficas del sistema para decodificar imágenes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Las dependencias primero y en su propia capa: mientras requirements.txt no
# cambie, reconstruir la imagen no vuelve a bajar 300 MB de wheels.
#
# Se instalan COMO ROOT y a nivel del sistema, no con `pip --user`. Parece un
# detalle y no lo es: `--user` deja los paquetes colgando de $HOME, y hay
# plataformas —Hugging Face Spaces entre ellas— que corren el contenedor con un
# HOME distinto del que tenía al construirse. Ahí Python no encontraría nada de
# lo instalado. En /usr/local están donde sea, y cualquiera los puede leer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Instanciar el motor una vez, en build.
#
# NO es para bajar los modelos: `rapidocr` 3.x los trae adentro del paquete
# (site-packages/rapidocr/models/), así que ya llegaron con el pip install de
# arriba. Este paso tarda un segundo y sirve para otra cosa: si algo del stack
# de ONNX no funciona en esta imagen, el build FALLA ACÁ, con el error a la
# vista, en vez de fallar en producción cuando alguien sube su primer
# documento.
RUN python -c "from app.ocr import motor; motor()"

# ── Y recién ahora, dejar de ser root ────────────────────────────────────────
#
# El proceso abre imágenes que le manda gente de afuera con OpenCV, libjpeg y un
# decodificador de códigos de barras: tres montones de C parseando archivos
# ajenos. Si alguna de esas bibliotecas tiene un agujero, que lo tenga como
# usuario común en vez de como root es la diferencia entre un susto y un
# problema.
#
# El uid 1000 no es arbitrario: es con el que Hugging Face Spaces corre los
# contenedores. Nada se escribe en disco en runtime —esta API no guarda nada—
# así que no hace falta que sea dueño de ningún directorio.
RUN useradd --create-home --uid 1000 docverify
USER docverify

# 7860 porque es lo que espera Hugging Face Spaces (su `app_port`). Sale por
# ${PORT}, así que una plataforma que inyecte otro puerto —Render, Cloud Run,
# el docker-compose.yml de al lado— también funciona sin tocar nada.
ENV PORT=7860
EXPOSE 7860

# El mismo /health que mira un balanceador, pero desde adentro, para que
# `docker ps` diga "healthy" o "unhealthy" en vez de solo "Up". Importa porque
# el modo de falla típico de este servicio no es morirse: es quedarse sin
# memoria durante un análisis, y ahí el proceso desaparece mientras el
# contenedor sigue figurando levantado.
#
# start-period de 90s: el arranque abre tres sesiones de ONNX en segundo plano
# y en una instancia con poca CPU eso son varios segundos. Sin ese margen, el
# contenedor se marcaría unhealthy durante un arranque perfectamente normal.
#
# Se usa urllib y no curl porque la imagen no trae curl y agregarlo por apt
# sería sumar superficie para un chequeo que Python ya sabe hacer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','7860')+'/health', timeout=4).read()" || exit 1

# Un solo worker: cada uno carga su propia copia de los modelos en memoria.
# Para escalar, más réplicas del contenedor antes que más workers adentro.
#
# --proxy-headers: detrás del proxy de la plataforma, sin esto uvicorn loguea
# la IP del proxy en todos los pedidos y no la de quien llamó de verdad.
#
# --forwarded-allow-ips='*': es lo que hace que lo anterior sirva de algo. Por
# defecto uvicorn solo le cree el X-Forwarded-For a 127.0.0.1, y el proxy nunca
# es 127.0.0.1 desde adentro del contenedor —es la IP de la red de Docker, o la
# del balanceador de la plataforma, y ninguna de las dos se conoce de antemano—.
# El contenedor no se publica desnudo a internet (va detrás del proxy, ver
# DEPLOY.md), así que el único que puede mandar ese header es el proxy.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
