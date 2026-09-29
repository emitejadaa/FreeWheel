# Imagen de la API de verificación documental.
#
# Es un Dockerfile corto porque no hay nada del sistema que instalar: el OCR
# corre sobre ONNX Runtime y el lector de códigos es zxing-cpp, los dos con
# wheels de pip. Nada de tesseract-ocr ni libzbar por apt.
#
# "slim" y no "alpine": las wheels de numpy, opencv y onnxruntime son para
# glibc (manylinux), y en Alpine (musl) habría que compilarlas.
FROM python:3.13-slim

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
# ${PORT}, así que una plataforma que inyecte otro puerto —Render, Cloud Run—
# también funciona sin tocar nada.
ENV PORT=7860
EXPOSE 7860

# Un solo worker: cada uno carga su propia copia de los modelos en memoria.
# Para escalar, más réplicas del contenedor antes que más workers adentro.
#
# --proxy-headers: detrás del proxy de la plataforma, sin esto uvicorn loguea
# la IP del proxy en todos los pedidos y no la de quien llamó de verdad.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers"]
