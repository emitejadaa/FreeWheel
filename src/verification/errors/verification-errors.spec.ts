import {
  VERIFICATION_ERROR_CODES,
  describeError,
  sample,
  verificationError,
} from "./verification-errors";

/**
 * El valor de este catálogo no está en el código que devuelve sino en que el
 * mensaje alcance para saber qué se rompió sin abrir el servidor. Estas
 * pruebas fijan eso: que ningún error salga sin explicación ni sin pista, y
 * que los datos del contexto lleguen al texto.
 */
describe("verificationError", () => {
  it("todos los códigos del catálogo tienen mensaje y pista", () => {
    for (const code of VERIFICATION_ERROR_CODES) {
      const error = verificationError(code);
      expect(error.message.length).toBeGreaterThan(20);
      expect(error.hint.length).toBeGreaterThan(20);
      // Un mensaje que termina en "undefined" es un contexto mal armado.
      expect(error.message).not.toContain("undefined");
      expect(error.hint).not.toContain("undefined");
    }
  });

  it("mete el contexto en el mensaje en vez de dejarlo genérico", () => {
    const error = verificationError("DNI_PDF417_INCOMPLETE", {
      fieldCount: 6,
      expected: 8,
      sample: "00123456789@PEREZ@JUAN",
    });

    expect(error.message).toContain("6 campos");
    expect(error.message).toContain("al menos 8");
    expect(error.message).toContain("00123456789@PEREZ@JUAN");
  });

  it("dice cuántas variantes se probaron cuando no aparece el código", () => {
    const error = verificationError("BARCODE_NOT_FOUND", {
      slot: "dni_front",
      formats: ["PDF417"],
      variants: 3,
    });

    expect(error.message).toContain("PDF417");
    expect(error.message).toContain("dni_front");
    expect(error.message).toContain("3 variantes");
  });

  it("expresa los tamaños en KB, no en bytes crudos", () => {
    const error = verificationError("IMAGE_TOO_LARGE", {
      bytes: 7_340_032,
      limit: 6_291_456,
    });

    expect(error.message).toContain("7168 KB");
    expect(error.message).toContain("6144 KB");
  });

  it("guarda el detalle solo cuando se le pasa uno", () => {
    expect(verificationError("STAGE_CRASHED").detail).toBeUndefined();
    expect(
      verificationError("STAGE_CRASHED", {}, "TypeError: x is not a function")
        .detail,
    ).toBe("TypeError: x is not a function");
  });

  it("describeError arma una línea de log con las tres partes", () => {
    const linea = describeError(verificationError("OCR_NOT_CONFIGURED"));
    expect(linea).toMatch(/^OCR_NOT_CONFIGURED: .+ → .+$/);
  });
});

describe("sample", () => {
  it("colapsa los espacios para que entre en una línea", () => {
    expect(sample("  hola\n\n  mundo  ")).toBe("hola mundo");
  });

  it("recorta lo largo y avisa con puntos suspensivos", () => {
    expect(sample("a".repeat(100), 10)).toBe(`${"a".repeat(10)}…`);
  });

  it("no toca lo que ya entra", () => {
    expect(sample("corto", 10)).toBe("corto");
  });
});
