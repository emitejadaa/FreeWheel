/**
 * ⚠️ TEMPORAL — MODO DEMO APAGADO. Ver src/common/demo-mode.ts.
 *
 * Lo que este archivo describe son las reglas DE VERDAD, y tienen que seguir
 * cubiertas mientras el andamio del demo esté puesto: con el modo encendido
 * estos tests afirmarían lo contrario de lo que dicen. El modo se prueba
 * aparte, en demo-mode.spec.ts.
 *
 * Se escribe antes de los imports —y por eso va con `process.env` pelado y no
 * en un `beforeAll`— porque hay módulos que leen la variable al cargarse.
 */
process.env.VERIFICATION_DEMO_MODE = "false";

import { evaluateDrivingEligibility } from "./driving-eligibility";

/**
 * Este control decide, en cada pedido, si alguien puede alquilar un auto. Los
 * dos errores posibles cuestan caro y en direcciones opuestas: de más, deja
 * manejar a quien no está habilitado; de menos, echa de la plataforma a
 * usuarios reales. Por eso están cubiertos los dos bordes.
 */

const HOY = new Date("2026-06-15T10:00:00.000Z");
const dia = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

const HABILITADO = {
  licenseExpiresAt: dia("2030-01-01"),
  licenseClass: "B.1",
  licenseBeginnerUntil: null,
};

const codigos = (r: { reasons: { code: string }[] }) =>
  r.reasons.map((motivo) => motivo.code);

describe("evaluateDrivingEligibility", () => {
  it("deja alquilar con licencia B vigente", () => {
    const resultado = evaluateDrivingEligibility(HABILITADO, HOY);

    expect(resultado.canRent).toBe(true);
    expect(resultado.reasons).toEqual([]);
  });

  it("no deja alquilar con la licencia vencida, y dice desde cuándo", () => {
    const resultado = evaluateDrivingEligibility(
      { ...HABILITADO, licenseExpiresAt: dia("2026-03-07") },
      HOY,
    );

    expect(resultado.canRent).toBe(false);
    expect(codigos(resultado)).toEqual(["LICENCIA_VENCIDA"]);
    // El mensaje tiene que alcanzar para entender qué pasó sin preguntarle a
    // nadie, y la fecha tiene que ser la real: formateada mal, diría el 6.
    expect(resultado.reasons[0].message).toContain("7/3/2026");
  });

  it("deja manejar el día mismo del vencimiento", () => {
    // Una licencia que vence el 15 vale todo el 15. Comparar instantes en vez
    // de días la cortaría a la hora exacta en que se guardó la fecha.
    const resultado = evaluateDrivingEligibility(
      { ...HABILITADO, licenseExpiresAt: dia("2026-06-15") },
      HOY,
    );

    expect(resultado.canRent).toBe(true);
  });

  it("no deja alquilar con una licencia de moto", () => {
    const resultado = evaluateDrivingEligibility(
      { ...HABILITADO, licenseClass: "A2.2" },
      HOY,
    );

    expect(resultado.canRent).toBe(false);
    expect(codigos(resultado)).toEqual(["LICENCIA_CLASE_NO_HABILITA"]);
    expect(resultado.reasons[0].message).toContain("A2.2");
  });

  it("no deja alquilar mientras dure el período de principiante", () => {
    const resultado = evaluateDrivingEligibility(
      { ...HABILITADO, licenseBeginnerUntil: dia("2026-10-28") },
      HOY,
    );

    expect(resultado.canRent).toBe(false);
    expect(codigos(resultado)).toEqual(["LICENCIA_PRINCIPIANTE"]);
  });

  it("vuelve a habilitar cuando el período de principiante terminó", () => {
    const resultado = evaluateDrivingEligibility(
      { ...HABILITADO, licenseBeginnerUntil: dia("2026-06-14") },
      HOY,
    );

    expect(resultado.canRent).toBe(true);
  });

  it("junta todos los motivos en vez de quedarse con el primero", () => {
    // Si el front solo mostrara uno, la persona arreglaría uno y volvería a
    // chocarse con el siguiente. Van todos.
    const resultado = evaluateDrivingEligibility(
      {
        licenseExpiresAt: dia("2020-01-01"),
        licenseClass: "A",
        licenseBeginnerUntil: dia("2027-01-01"),
      },
      HOY,
    );

    expect(codigos(resultado)).toEqual([
      "LICENCIA_VENCIDA",
      "LICENCIA_CLASE_NO_HABILITA",
      "LICENCIA_PRINCIPIANTE",
    ]);
  });

  describe("lo que no se sabe no bloquea", () => {
    // Es la decisión que evita romper a todos los usuarios ya verificados el
    // día del deploy: las licencias aprobadas antes de que existiera la
    // lectura automática no tienen ninguno de estos datos cargados.
    it("sin vencimiento conocido, deja alquilar", () => {
      const resultado = evaluateDrivingEligibility(
        {
          licenseExpiresAt: null,
          licenseClass: null,
          licenseBeginnerUntil: null,
        },
        HOY,
      );

      expect(resultado.canRent).toBe(true);
      expect(resultado.expiresSoon).toBe(false);
    });

    it("sin clase conocida, no se asume que es de moto", () => {
      const resultado = evaluateDrivingEligibility(
        { ...HABILITADO, licenseClass: null },
        HOY,
      );

      expect(resultado.canRent).toBe(true);
    });
  });

  describe("aviso previo al vencimiento", () => {
    it("avisa cuando faltan menos de 30 días, sin bloquear todavía", () => {
      const resultado = evaluateDrivingEligibility(
        { ...HABILITADO, licenseExpiresAt: dia("2026-07-01") },
        HOY,
      );

      expect(resultado.canRent).toBe(true);
      expect(resultado.expiresSoon).toBe(true);
    });

    it("no avisa cuando todavía falta mucho", () => {
      const resultado = evaluateDrivingEligibility(
        { ...HABILITADO, licenseExpiresAt: dia("2027-01-01") },
        HOY,
      );

      expect(resultado.expiresSoon).toBe(false);
    });

    it("no avisa sobre algo que ya venció: para eso está el bloqueo", () => {
      const resultado = evaluateDrivingEligibility(
        { ...HABILITADO, licenseExpiresAt: dia("2026-06-01") },
        HOY,
      );

      expect(resultado.canRent).toBe(false);
      expect(resultado.expiresSoon).toBe(false);
    });
  });
});
