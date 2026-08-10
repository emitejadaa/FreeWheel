import {
  addressSimilarity,
  ageOn,
  compareNames,
  isNotExpired,
  normalizeDate,
  normalizeDni,
  normalizeSex,
  normalizeText,
  tokenize,
} from "./normalize.util";

describe("normalizeText", () => {
  it("quita tildes, pasa a mayúsculas y colapsa espacios", () => {
    expect(normalizeText("  José   Martín  Ñandú ")).toBe("JOSE MARTIN NANDU");
    expect(normalizeText("D'Angelo-Pérez")).toBe("D ANGELO PEREZ");
  });

  it("es idempotente y estable ante puntuación", () => {
    expect(normalizeText(normalizeText("Av. Siempre Viva 742"))).toBe(
      "AV SIEMPRE VIVA 742",
    );
  });
});

describe("tokenize", () => {
  it("devuelve tokens y lista vacía para cadenas sin contenido", () => {
    expect(tokenize("Juan Carlos")).toEqual(["JUAN", "CARLOS"]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("normalizeDni", () => {
  it("acepta con puntos, espacios y ceros a la izquierda", () => {
    expect(normalizeDni("12.345.678")).toBe("12345678");
    expect(normalizeDni(" 12 345 678 ")).toBe("12345678");
    expect(normalizeDni("01234567")).toBe("1234567");
  });

  it("rechaza largos fuera de 7-8 dígitos", () => {
    expect(normalizeDni("12345")).toBeNull();
    expect(normalizeDni("123456789")).toBeNull();
    expect(normalizeDni("ABCDEFGH")).toBeNull();
  });
});

describe("normalizeSex", () => {
  it("mapea las formas usuales", () => {
    expect(normalizeSex("M")).toBe("M");
    expect(normalizeSex("masculino")).toBe("M");
    expect(normalizeSex("F")).toBe("F");
    expect(normalizeSex("Femenino")).toBe("F");
    expect(normalizeSex("X")).toBeNull();
  });
});

describe("normalizeDate", () => {
  it("acepta DD/MM/YYYY, YYYY-MM-DD y YYMMDD del MRZ", () => {
    expect(normalizeDate("01/02/1990")).toBe("1990-02-01");
    expect(normalizeDate("1/2/1990")).toBe("1990-02-01");
    expect(normalizeDate("1990-02-01")).toBe("1990-02-01");
    expect(normalizeDate("900201")).toBe("1990-02-01");
  });

  it("interpreta la ventana de 2 dígitos del MRZ para vencimientos futuros", () => {
    // 30 → 2030 (vencimiento), no 1930.
    expect(normalizeDate("301231")).toBe("2030-12-31");
  });

  it("rechaza fechas que no existen y formatos desconocidos", () => {
    expect(normalizeDate("31/02/2000")).toBeNull();
    expect(normalizeDate("2000-13-01")).toBeNull();
    expect(normalizeDate("hola")).toBeNull();
    expect(normalizeDate("")).toBeNull();
  });
});

describe("ageOn", () => {
  const reference = new Date("2026-08-03T00:00:00.000Z");

  it("calcula la edad cumplida en UTC", () => {
    expect(ageOn("1990-01-01", reference)).toBe(36);
    expect(ageOn("2008-08-03", reference)).toBe(18);
    // Cumple mañana: todavía tiene 17.
    expect(ageOn("2008-08-04", reference)).toBe(17);
  });
});

describe("isNotExpired", () => {
  const reference = new Date("2026-08-03T12:00:00.000Z");

  it("acepta hoy y futuro, rechaza ayer", () => {
    expect(isNotExpired("2026-08-03", reference)).toBe(true);
    expect(isNotExpired("2030-01-01", reference)).toBe(true);
    expect(isNotExpired("2026-08-02", reference)).toBe(false);
  });
});

describe("compareNames", () => {
  it("match exacto ignorando tildes y mayúsculas", () => {
    expect(compareNames("José Martín", "JOSE MARTIN")).toBe("match");
  });

  it("partial cuando el documento agrega nombres de pila", () => {
    expect(compareNames("Juan", "JUAN CARLOS")).toBe("partial");
    expect(compareNames("Juan Carlos", "JUAN")).toBe("partial");
  });

  it("mismatch cuando el nombre identificatorio no aparece", () => {
    expect(compareNames("Pedro", "JUAN CARLOS")).toBe("mismatch");
    expect(compareNames("Perez", "GOMEZ")).toBe("mismatch");
    expect(compareNames("", "JUAN")).toBe("mismatch");
  });
});

describe("addressSimilarity", () => {
  it("es alta entre escrituras distintas del mismo domicilio", () => {
    expect(
      addressSimilarity(
        "Av. Siempre Viva 742",
        "AVENIDA SIEMPRE VIVA 742, CABA",
      ),
    ).toBe(1);
  });

  it("es baja entre domicilios distintos", () => {
    expect(
      addressSimilarity("Av. Siempre Viva 742", "Calle Falsa 123, Rosario"),
    ).toBeLessThan(0.5);
  });

  it("es 0 cuando falta información", () => {
    expect(addressSimilarity("", "Av. Siempre Viva 742")).toBe(0);
    expect(addressSimilarity("Av. de la Calle", "")).toBe(0);
  });
});
