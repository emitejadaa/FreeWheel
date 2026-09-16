/**
 * ⚠️ TEMPORAL — EL ANDAMIO DEL DEMO, PROBADO. Ver demo-mode.ts.
 *
 * Este archivo cuida dos cosas a la vez, y las dos importan mientras el modo
 * esté puesto:
 *
 *   · que ENCENDIDO relaje lo que tiene que relajar — si no, el front se traba
 *     en el control que este modo existe para sacar del medio;
 *   · que ENCENDIDO siga exigiendo que el documento sea de esta persona. Un
 *     demo que aprueba cualquier cosa no prueba ningún flujo: prueba que el
 *     backend dice que sí.
 *
 * Todo esto se va con el `git revert` del commit que lo trajo.
 */
import { User, VerifiedDocumentType } from "@prisma/client";
import { isAdultDate } from "./validators/is-adult-date.validator";
import { evaluateDrivingEligibility } from "../verification/identity/driving-eligibility";
import { IdentityMatchService } from "../verification/identity/identity-match.service";
import type { DocverifyResult } from "../verification/identity/docverify.client";

const matcher = new IdentityMatchService();

const CUENTA = {
  id: "user-1",
  firstName: "EMILIANO",
  lastName: "TEJADA ARAGON",
  dni: "49380010",
  cuil: "20-49380010-9",
  dateOfBirth: new Date("2009-04-06T12:00:00.000Z"),
} as unknown as User;

function lectura(
  porOrigen: Record<string, Record<string, string>>,
): DocverifyResult {
  const caras: DocverifyResult["caras"] = {};
  for (const [ruta, campos] of Object.entries(porOrigen)) {
    const [cara, origen] = ruta.split(".");
    caras[cara] ??= { ok: true, documento: cara, origenes: {} };
    caras[cara].origenes![origen] = {
      ok: true,
      disponible: true,
      error: "",
      campos: Object.fromEntries(
        Object.entries(campos).map(([nombre, valor]) => [
          nombre,
          { valor, crudo: valor, confianza: 0.95 },
        ]),
      ),
    };
  }
  return {
    ok: true,
    documento: "dni",
    version: "2.0.0",
    ms: 4200,
    caras,
    coincidencias: {},
  };
}

const codigos = (r: { reasons: { code: string }[] }) =>
  r.reasons.map((motivo) => motivo.code);

/** La fecha de nacimiento de alguien que cumple `edad` hoy. */
function naceHace(edad: number): string {
  const hoy = new Date();
  return new Date(
    Date.UTC(hoy.getUTCFullYear() - edad, hoy.getUTCMonth(), hoy.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
}

describe("modo demo · lo que relaja", () => {
  const previo = process.env.VERIFICATION_DEMO_MODE;
  beforeEach(() => {
    process.env.VERIFICATION_DEMO_MODE = "true";
  });
  afterAll(() => {
    process.env.VERIFICATION_DEMO_MODE = previo;
  });

  it("acepta a alguien de 17", () => {
    expect(isAdultDate(naceHace(17))).toBe(true);
    // 16 sigue afuera: el piso bajó un año, no desapareció.
    expect(isAdultDate(naceHace(16))).toBe(false);
  });

  it("deja alquilar con la licencia vencida, de moto y de principiante", () => {
    const eligibility = evaluateDrivingEligibility({
      licenseExpiresAt: new Date("2020-01-01T12:00:00.000Z"),
      licenseClass: "A2.2",
      licenseBeginnerUntil: new Date("2099-01-01T12:00:00.000Z"),
    });

    expect(eligibility.canRent).toBe(true);
    expect(eligibility.reasons).toEqual([]);
  });

  it("aprueba una licencia vencida y de principiante", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      lectura({
        "frente.ocr": {
          apellido: "TEJADA ARAGON",
          nombre: "EMILIANO",
          numero_licencia: "49380010",
          fecha_vencimiento: "2020-01-01",
          clase: "A2.2",
        },
        "dorso.ocr": {
          es_principiante: "true",
          fin_principiante: "2099-10-28",
        },
      }),
      CUENTA,
    );

    expect(report.verdict).toBe("APPROVE");
    expect(report.reasons).toEqual([]);
    // Lo leído se guarda igual: al revertir el andamio, el control de
    // habilitación vuelve a tener con qué decidir sin reverificar a nadie.
    expect(report.facts.licenseClass).toBe("A2.2");
    expect(report.facts.expiresAt?.toISOString().slice(0, 10)).toBe(
      "2020-01-01",
    );
  });

  it("aprueba un DNI sin código y sin fecha de nacimiento legible", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      lectura({
        "frente.ocr": {
          apellido: "TEJADA ARAGON",
          nombre: "EMILIANO",
          numero_documento: "49380010",
        },
      }),
      CUENTA,
    );

    expect(report.verdict).toBe("APPROVE");
    expect(codigos(report)).not.toContain("CODIGO_NO_LEIDO");
    expect(codigos(report)).not.toContain("DATO_ILEGIBLE");
  });
});

describe("modo demo · lo que NO relaja", () => {
  const previo = process.env.VERIFICATION_DEMO_MODE;
  beforeEach(() => {
    process.env.VERIFICATION_DEMO_MODE = "true";
  });
  afterAll(() => {
    process.env.VERIFICATION_DEMO_MODE = previo;
  });

  it("sigue sin aprobar el documento de otra persona", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      lectura({
        "frente.ocr": {
          apellido: "GOMEZ",
          nombre: "LUCIA",
          numero_documento: "30111222",
        },
      }),
      CUENTA,
    );

    expect(report.verdict).toBe("MANUAL_REVIEW");
    expect(codigos(report)).toContain("DATO_NO_COINCIDE_CON_LA_CUENTA");
  });

  it("sigue detectando la tarjeta que se contradice a sí misma", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      lectura({
        "frente.ocr": {
          apellido: "TEJADA ARAGON",
          nombre: "EMILIANO",
          numero_documento: "49380010",
        },
        "frente.pdf417": {
          apellido: "TEJADA ARAGON",
          nombre: "EMILIANO",
          numero_documento: "30111222",
        },
      }),
      CUENTA,
    );

    expect(report.verdict).toBe("MANUAL_REVIEW");
    expect(codigos(report)).toContain("DATO_NO_COINCIDE_ENTRE_ORIGENES");
  });

  it("sigue exigiendo que el CUIL corresponda al DNI", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      lectura({
        "frente.ocr": {
          apellido: "TEJADA ARAGON",
          nombre: "EMILIANO",
          numero_documento: "49380010",
        },
        "dorso.ocr": { cuil: "20-30111222-3" },
      }),
      CUENTA,
    );

    expect(codigos(report)).toContain("CUIL_NO_CORRESPONDE_AL_DNI");
  });
});

describe("modo demo · el interruptor", () => {
  const previo = process.env.VERIFICATION_DEMO_MODE;
  afterAll(() => {
    process.env.VERIFICATION_DEMO_MODE = previo;
  });

  it("se apaga con VERIFICATION_DEMO_MODE=false y vuelven las reglas", () => {
    process.env.VERIFICATION_DEMO_MODE = "false";

    expect(isAdultDate(naceHace(17))).toBe(false);
    expect(
      evaluateDrivingEligibility({
        licenseExpiresAt: new Date("2020-01-01T12:00:00.000Z"),
        licenseClass: "B.1",
        licenseBeginnerUntil: null,
      }).canRent,
    ).toBe(false);
  });

  it("viene encendido cuando nadie configuró nada", () => {
    delete process.env.VERIFICATION_DEMO_MODE;

    expect(isAdultDate(naceHace(17))).toBe(true);
  });
});
