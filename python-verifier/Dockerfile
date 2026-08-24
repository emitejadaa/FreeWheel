# Verificador de documentos de FreeWheel, listo para desplegar.
#
# POR QUÉ HAY UN DOCKERFILE
# El backend corre en Vercel serverless, donde no hay Python ni el binario de
# tesseract y no los puede haber: son dependencias del sistema operativo. Así
# que el verificador se despliega APARTE (Render, Railway, Fly, un VPS con
# Docker) y el backend le habla por HTTP con DOCVERIFY_URL.
#
#   docker build -t freewheel-docverify .
#   docker run -p 8000:8000 -e DOCVERIFY_TOKEN=<clave larga> freewheel-docverify
#
# Y en el backend:
#   DOCVERIFY_URL=https://<donde-quedo-esto>
#   DOCVERIFY_TOKEN=<la misma clave>

FROM python:3.11-slim

# tesseract con español: es LA dependencia de sistema del OCR y sin ella todo
# documento falla. libgl/libglib las pide opencv aunque sea la versión headless.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-spa \
      tesseract-ocr-eng \
      libgl1 \
      libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Las dependencias primero, en su propia capa: cambiar el código no reinstala
# opencv (que tarda).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# No corre como root: esto recibe documentos de identidad de gente real.
RUN useradd --create-home --shell /usr/sbin/nologin docverify \
    && chown -R docverify:docverify /app
USER docverify

ENV PORT=8000
EXPOSE 8000

# Chequea el binario de tesseract, no solo que el proceso esté vivo: sin
# tesseract el servidor levanta igual y contesta, pero no verifica nada.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD python -c "import json,urllib.request,sys; \
sys.exit(0 if json.load(urllib.request.urlopen('http://127.0.0.1:8000/health'))['ok'] else 1)"

CMD ["python", "server.py"]
