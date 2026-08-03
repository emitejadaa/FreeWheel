import { parseLicenseCode } from "./license-code.parser";

describe("parseLicenseCode", () => {
  it("lee pares clave=valor", () => {
    expect(parseLicenseCode("DNI=12345678;VTO=01/03/2030")).toEqual({
      dni: "12345678",
      expiryDate: "2030-03-01",
      parsed: true,
    });
  });

  it("lee JSON", () => {
    const payload = JSON.stringify({
      documento: "12.345.678",
      vencimiento: "2030-03-01",
      clase: "B1",
    });
    expect(parseLicenseCode(payload)).toEqual({
      dni: "12345678",
      expiryDate: "2030-03-01",
      parsed: true,
    });
  });

  it("lee la query string de una URL de validación", () => {
    const parsed = parseLicenseCode(
      "https://licencias.example.gob.ar/v?dni=12345678&vto=01/03/2030",
    );
    expect(parsed.dni).toBe("12345678");
    expect(parsed.expiryDate).toBe("2030-03-01");
  });

  it("lee payloads delimitados por @", () => {
    const parsed = parseLicenseCode("LIC@12345678@PEREZ@B1@01/03/2030");
    expect(parsed.dni).toBe("12345678");
    expect(parsed.expiryDate).toBe("2030-03-01");
  });

  it("marca parsed=false ante un payload opaco (nunca bloquea)", () => {
    expect(parseLicenseCode("https://example.com/l/9f8a7b6c")).toEqual({
      dni: null,
      expiryDate: null,
      parsed: false,
    });
    expect(parseLicenseCode("A9F8B7C6D5")).toEqual({
      dni: null,
      expiryDate: null,
      parsed: false,
    });
    expect(parseLicenseCode("")).toEqual({
      dni: null,
      expiryDate: null,
      parsed: false,
    });
  });

  it("marca parsed=true si logra leer aunque sea un campo", () => {
    const parsed = parseLicenseCode("DNI=12345678");
    expect(parsed).toEqual({
      dni: "12345678",
      expiryDate: null,
      parsed: true,
    });
  });

  it("no explota con JSON inválido", () => {
    expect(parseLicenseCode("{no es json}").parsed).toBe(false);
  });
});
