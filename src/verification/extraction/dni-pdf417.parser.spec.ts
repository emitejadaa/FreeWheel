import { parseDniPdf417, tryParseDniPdf417 } from "./dni-pdf417.parser";

// Payloads sintéticos con la forma del PDF417 real (sin datos de personas).
const CANONICAL =
  "00123456789@PEREZ@JUAN CARLOS@M@12345678@A@01/02/1990@05/03/2015";

describe("parseDniPdf417", () => {
  it("lee el payload canónico de 8 campos", () => {
    expect(parseDniPdf417(CANONICAL)).toEqual({
      procedureNumber: "00123456789",
      lastName: "PEREZ",
      firstName: "JUAN CARLOS",
      sex: "M",
      dni: "12345678",
      copy: "A",
      birthDate: "1990-02-01",
      issueDate: "2015-03-05",
    });
  });

  it("tolera variantes con campos extra al final", () => {
    const withExtras = `${CANONICAL}@20123456786@OFICINA 123`;
    expect(parseDniPdf417(withExtras)?.dni).toBe("12345678");
    expect(parseDniPdf417(withExtras)?.birthDate).toBe("1990-02-01");
  });

  it("normaliza el DNI con puntos y el sexo en texto largo", () => {
    const payload =
      "00123456789@GOMEZ@MARIA@FEMENINO@12.345.679@A@10/12/1985@01/01/2016";
    const parsed = parseDniPdf417(payload);
    expect(parsed?.dni).toBe("12345679");
    expect(parsed?.sex).toBe("F");
  });

  it("acepta que falte la fecha de emisión", () => {
    const payload = "00123456789@PEREZ@JUAN@M@12345678@A@01/02/1990@";
    expect(parseDniPdf417(payload)?.issueDate).toBeNull();
  });

  it("devuelve null si faltan campos, el DNI o la fecha de nacimiento", () => {
    expect(parseDniPdf417("00123@PEREZ@JUAN@M")).toBeNull();
    expect(
      parseDniPdf417("00123456789@PEREZ@JUAN@M@@A@01/02/1990@05/03/2015"),
    ).toBeNull();
    expect(
      parseDniPdf417("00123456789@PEREZ@JUAN@M@12345678@A@31/02/1990@"),
    ).toBeNull();
    expect(
      parseDniPdf417("00123456789@@JUAN@M@12345678@A@01/02/1990@"),
    ).toBeNull();
  });

  it("devuelve null ante un payload que no es del DNI", () => {
    expect(parseDniPdf417("https://example.com/algo")).toBeNull();
    expect(parseDniPdf417("")).toBeNull();
  });
});

/**
 * La versión que devuelve el motivo. Existe porque `null` no distingue "esto
 * no es un PDF417 del RENAPER" de "sí lo es y se leyó a medias", y esas dos
 * cosas se arreglan distinto: una es la foto equivocada, la otra es la misma
 * foto sacada mejor.
 */
describe("tryParseDniPdf417", () => {
  it("dice que no tiene la forma del RENAPER cuando no hay separadores", () => {
    const result = tryParseDniPdf417("https://ejemplo.test/algo");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DNI_PDF417_MALFORMED");
    expect(result.error.message).toContain("ejemplo.test");
  });

  it("cuenta los campos cuando el código se leyó a medias", () => {
    const result = tryParseDniPdf417("00123456789@PEREZ@JUAN@M");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DNI_PDF417_INCOMPLETE");
    expect(result.error.message).toContain("4 campos");
    expect(result.error.message).toContain("al menos 8");
  });

  it("nombra el campo cuando el número de documento no es un DNI", () => {
    const result = tryParseDniPdf417(
      "00123456789@PEREZ@JUAN@M@XX@A@01/02/1990@05/03/2015",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DNI_PDF417_NO_NUMBER");
    expect(result.error.message).toContain("XX");
  });

  it("nombra el campo cuando la fecha de nacimiento no se entiende", () => {
    const result = tryParseDniPdf417(
      "00123456789@PEREZ@JUAN@M@12345678@A@99/99/9999@05/03/2015",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DNI_PDF417_NO_BIRTHDATE");
    expect(result.error.message).toContain("99/99/9999");
  });

  it("avisa cuando falta el nombre", () => {
    const result = tryParseDniPdf417(
      "00123456789@PEREZ@@M@12345678@A@01/02/1990@05/03/2015",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DNI_PDF417_NO_NAMES");
  });

  it("devuelve los datos, sin advertencias, cuando el código está bien", () => {
    const result = tryParseDniPdf417(CANONICAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.dni).toBe("12345678");
    expect(result.warnings).toEqual([]);
  });
});
