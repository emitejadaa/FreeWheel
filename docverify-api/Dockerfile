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
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Los modelos de OCR (~100 MB) se bajan la primera vez que se instancia el
# motor. Se precargan ACÁ, en build, para que no los baje el primer request en
# producción: si no, la primera persona que sube una foto espera la descarga.
RUN python -c "from app.ocr import motor; motor()"

ENV PORT=8000
EXPOSE 8000

# Un solo worker: cada uno carga su propia copia de los modelos en memoria.
# Para escalar, más réplicas del contenedor antes que más workers adentro.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
