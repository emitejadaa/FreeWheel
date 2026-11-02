# Entrypoint para HosTICer: tic corre `uvicorn main:app` desde esta carpeta.
import os

# onnxruntime 1.30 guarda telemetría en $HOME/.cache, que en HosTICer es de solo lectura.
os.environ.setdefault("ORT_DISABLE_TELEMETRY", "1")

from app.main import app as app  # noqa: E402
