def test_los_modulos_importan_sin_explotar():
    import analyze  # noqa: F401
    import campos  # noqa: F401
    import codigos  # noqa: F401
    import contrato  # noqa: F401
    import imagen  # noqa: F401
    import normalizadores  # noqa: F401
    import server  # noqa: F401


def test_dependencias_instaladas():
    import cv2  # noqa: F401
    import pytesseract  # noqa: F401
    import zxingcpp  # noqa: F401
