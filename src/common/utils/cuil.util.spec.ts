import {
  cuilChecksumValid,
  cuilEmbeddedDni,
  cuilPrefixSex,
  dniMatchesCuil,
  isValidPersonCuil,
  normalizeCuil,
} from "./cuil.util";

// CUILs sintéticos con checksum real: 20-12345678-6, 27-12345678-0,
// 20-87654321-5 (verificados a mano con los pesos 5,4,3,2,7,6,5,4,3,2).
// - [Pruebas 1] describe agrupa las pruebas de una función
describe("normalizeCuil", () => {
  // - [Pruebas 2] Cada it es un caso, escrito como una frase
  it("acepta con y sin guiones/espacios", () => {
    // - [Pruebas 3] Lo que tiene que devolver. Si devuelve otra cosa, falla
    expect(normalizeCuil("20-12345678-6")).toBe("20123456786");
    expect(normalizeCuil("20 12345678 6")).toBe("20123456786");
    expect(normalizeCuil("20123456786")).toBe("20123456786");
  });

  // - [Pruebas 4] También se prueban los casos de error
  it("rechaza largos incorrectos y no-dígitos", () => {
    // - [Pruebas 5] Un CUIL mal formado tiene que devolver null
    expect(normalizeCuil("20-1234567-6")).toBeNull();
    expect(normalizeCuil("20-12345678-66")).toBeNull();
    expect(normalizeCuil("20-1234567A-6")).toBeNull();
    expect(normalizeCuil("")).toBeNull();
  });
});

describe("cuilChecksumValid", () => {
  it("acepta dígitos verificadores correctos", () => {
    expect(cuilChecksumValid("20123456786")).toBe(true);
    expect(cuilChecksumValid("27123456780")).toBe(true);
    expect(cuilChecksumValid("20876543215")).toBe(true);
  });

  it("rechaza un dígito verificador incorrecto", () => {
    expect(cuilChecksumValid("20123456787")).toBe(false);
    expect(cuilChecksumValid("27123456781")).toBe(false);
  });

  it("rechaza bases cuyo verificador daría 10 (no existen como CUIL)", () => {
    // Base 2000000001: suma ponderada 12 → resto 1 → dv 10 → inválido con
    // cualquier dígito final.
    for (let digit = 0; digit <= 9; digit += 1) {
      expect(cuilChecksumValid(`2000000001${digit}`)).toBe(false);
    }
  });
});

describe("cuilEmbeddedDni / dniMatchesCuil", () => {
  it("extrae el DNI embebido de 8 dígitos", () => {
    expect(cuilEmbeddedDni("20123456786")).toBe("12345678");
  });

  it("matchea DNIs de 7 dígitos con cero a la izquierda", () => {
    expect(dniMatchesCuil("1234567", "20012345677")).toBe(true);
    expect(dniMatchesCuil("12345678", "20123456786")).toBe(true);
    expect(dniMatchesCuil("87654321", "20123456786")).toBe(false);
  });
});

describe("cuilPrefixSex", () => {
  it("mapea 20 a M y 27 a F", () => {
    expect(cuilPrefixSex("20123456786")).toBe("M");
    expect(cuilPrefixSex("27123456780")).toBe("F");
  });

  it("es no concluyente para prefijos de excepción", () => {
    expect(cuilPrefixSex("23123456789")).toBeNull();
    expect(cuilPrefixSex("24123456789")).toBeNull();
  });
});

describe("isValidPersonCuil", () => {
  it("acepta CUILs de persona con checksum válido", () => {
    expect(isValidPersonCuil("20-12345678-6")).toBe(true);
    expect(isValidPersonCuil("27123456780")).toBe(true);
  });

  it("rechaza prefijos de sociedad aunque el checksum cierre", () => {
    // 30-12345678-? : suma 2*5+... — cualquier dv correcto sigue siendo
    // una sociedad, no una persona.
    expect(isValidPersonCuil("30123456780")).toBe(false);
    expect(isValidPersonCuil("30123456781")).toBe(false);
    expect(isValidPersonCuil("30123456782")).toBe(false);
    expect(isValidPersonCuil("30123456783")).toBe(false);
    expect(isValidPersonCuil("30123456784")).toBe(false);
    expect(isValidPersonCuil("30123456785")).toBe(false);
    expect(isValidPersonCuil("30123456786")).toBe(false);
    expect(isValidPersonCuil("30123456787")).toBe(false);
    expect(isValidPersonCuil("30123456788")).toBe(false);
    expect(isValidPersonCuil("30123456789")).toBe(false);
  });

  it("rechaza checksum inválido y formatos rotos", () => {
    expect(isValidPersonCuil("20-12345678-7")).toBe(false);
    expect(isValidPersonCuil("no-es-un-cuil")).toBe(false);
  });
});
