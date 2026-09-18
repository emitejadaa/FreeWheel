import { isAdultDate } from "./is-adult-date.validator";

/** YYYY-MM-DD `years` before today, in UTC. */
function yearsAgo(years: number, extraDays = 0): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d.toISOString().slice(0, 10);
}

describe("isAdultDate", () => {
  it("accepts a clearly-adult birth date", () => {
    expect(isAdultDate("1990-01-01")).toBe(true);
  });

  it("accepts someone who turns 18 exactly today", () => {
    expect(isAdultDate(yearsAgo(18))).toBe(true);
  });

  it("rejects someone whose 18th birthday is still one day away", () => {
    // Born 18 years ago minus one day → 18th birthday is tomorrow → still 17.
    expect(isAdultDate(yearsAgo(18, 1))).toBe(false);
  });

  it("rejects a minor", () => {
    expect(isAdultDate(yearsAgo(15))).toBe(false);
  });

  it("rejects an implausibly old date (over 120)", () => {
    expect(isAdultDate("1800-01-01")).toBe(false);
  });

  it("rejects a malformed or impossible calendar date", () => {
    expect(isAdultDate("2000-13-01")).toBe(false);
    expect(isAdultDate("2000-02-30")).toBe(false);
    expect(isAdultDate("1990/01/01")).toBe(false);
    expect(isAdultDate("not-a-date")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isAdultDate(undefined)).toBe(false);
    expect(isAdultDate(null)).toBe(false);
    expect(isAdultDate(19900101)).toBe(false);
    expect(isAdultDate(new Date())).toBe(false);
  });
});

/**
 * FASE DE PRUEBA · borrar junto con cuenta-de-prueba.ts.
 *
 * La cuenta de prueba de la demo tiene 17 años, así que sin esto no puede
 * siquiera registrarse y no hay nada que probar. El límite baja para ESE mail
 * y nada más: es la única forma de aflojar la regla sin aflojarla para todos.
 */
describe("isAdultDate · la cuenta de prueba", () => {
  afterEach(() => {
    delete process.env.VERIFICACION_CUENTA_DE_PRUEBA;
  });

  it("acepta a alguien de 17 cuando el mail es el de la cuenta de prueba", () => {
    process.env.VERIFICACION_CUENTA_DE_PRUEBA = "demo@freewheel.test";

    expect(isAdultDate(yearsAgo(17), "demo@freewheel.test")).toBe(true);
  });

  it("baja el límite a 17, no lo saca: a los 16 sigue sin poder", () => {
    process.env.VERIFICACION_CUENTA_DE_PRUEBA = "demo@freewheel.test";

    expect(isAdultDate(yearsAgo(16), "demo@freewheel.test")).toBe(false);
  });

  it("no le baja el límite a ninguna otra cuenta", () => {
    process.env.VERIFICACION_CUENTA_DE_PRUEBA = "demo@freewheel.test";

    expect(isAdultDate(yearsAgo(17), "otra@freewheel.test")).toBe(false);
  });

  it("sin la variable configurada, ese mail no tiene ningún privilegio", () => {
    expect(isAdultDate(yearsAgo(17), "demo@freewheel.test")).toBe(false);
  });

  it("sigue rechazando una fecha que no existe, cuenta de prueba o no", () => {
    process.env.VERIFICACION_CUENTA_DE_PRUEBA = "demo@freewheel.test";

    expect(isAdultDate("2000-02-31", "demo@freewheel.test")).toBe(false);
  });

  it("sin mail se comporta como siempre: 18", () => {
    process.env.VERIFICACION_CUENTA_DE_PRUEBA = "demo@freewheel.test";

    expect(isAdultDate(yearsAgo(17))).toBe(false);
  });
});
