import { parseDniPdf417 } from "./dni-pdf417.parser";

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
