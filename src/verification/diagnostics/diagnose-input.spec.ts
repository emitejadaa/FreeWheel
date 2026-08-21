import {
  buildExtractionFromDiagnoses,
  missingProfileFields,
  parseProfileInput,
} from "./diagnose-input";
import { IdentityProfileSnapshot } from "../matching/identity-match.service";

const PDF417 =
  "00123456789@PEREZ@JUAN CARLOS@M@12345678@A@01/02/1990@05/03/2015";
const MRZ = [
  "I<ARG12345678<8<<<<<<<<<<<<<<<",
  "9002018M3002153ARG<<<<<<<<<<<8",
  "PEREZ<<JUAN<CARLOS<<<<<<<<<<<<",
];

const CUENTA: IdentityProfileSnapshot = {
  firstName: "Juan Carlos",
  lastName: "Perez",
  dateOfBirth: new Date("1990-02-01T00:00:00.000Z"),
  dni: "12345678",
  cuil: "20123456786",
  address: "Av. Siempre Viva 742",
};

/** Lo que devuelve POST /verification/diagnose/document para una foto. */
const respuesta = (payloads: string[], ocr?: Record<string, unknown>) => ({
  codes: { codes: payloads.map((payload) => ({ payload, kind: "unknown" })) },
  ...(ocr ? { ocr } : {}),
});

/**
 * El cliente manda de vuelta lo que le devolvió el diagnóstico foto por foto.
 * La regla acá es que NADA de lo que manda se toma por bueno: los códigos se
 * vuelven a interpretar desde su texto crudo, así lo que decide es el backend
 * y no un objeto armado a mano.
 */
describe("buildExtractionFromDiagnoses", () => {
  it("vuelve a interpretar el PDF417 desde su payload crudo", () => {
    const result = buildExtractionFromDiagnoses({
      dni_front: respuesta([PDF417]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.dniBarcode).toMatchObject({
      dni: "12345678",
      lastName: "PEREZ",
      birthDate: "1990-02-01",
    });
  });

  it("no le cree al cliente si manda los datos ya parseados", () => {
    // El payload dice otra cosa: gana el payload.
    const result = buildExtractionFromDiagnoses({
      dni_front: {
        codes: {
          codes: [
            {
              payload: PDF417,
              kind: "dni_pdf417",
              dni: { dni: "99999999", lastName: "IMPOSTOR" },
            },
          ],
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.dniBarcode?.dni).toBe("12345678");
    expect(result.data.dniBarcode?.lastName).toBe("PEREZ");
  });

  it("distingue el código de la licencia del del DNI", () => {
    const result = buildExtractionFromDiagnoses({
      dni_front: respuesta([PDF417]),
      license_back: respuesta(["DNI=12345678;VTO=20/05/2031"]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.licenseCode).toEqual({
      dni: "12345678",
      expiryDate: "2031-05-20",
      parsed: true,
    });
  });

  it("baja el texto leído a la forma que consume el cruce", () => {
    const result = buildExtractionFromDiagnoses({
      dni_front: respuesta([], {
        classifiedAs: "dni_front",
        fields: {
          lastName: { raw: "PEREZ", value: "PEREZ" },
          documentNumber: { raw: "12.345.678", value: "12345678" },
        },
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Va el texto CRUDO: el cruce normaliza por su cuenta.
    expect(result.data.ocr.dni_front?.fields).toEqual({
      apellido: "PEREZ",
      nroDocumento: "12.345.678",
    });
  });

  it("arma el MRZ con las líneas del dorso", () => {
    const result = buildExtractionFromDiagnoses({
      dni_back: respuesta([], { classifiedAs: "dni_back", mrzLines: MRZ }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.mrz?.checksumValid).toBe(true);
  });

  it("dice qué se esperaba cuando llega cualquier cosa", () => {
    const result = buildExtractionFromDiagnoses("no soy un objeto");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXTRACTION_INPUT_INVALID");
    expect(result.error.message).toContain("una clave por documento");
  });

  it("dice cuáles son las claves esperadas cuando no hay ninguna", () => {
    const result = buildExtractionFromDiagnoses({ frente: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("dni_front");
  });

  it("nombra el documento que llegó mal armado", () => {
    const result = buildExtractionFromDiagnoses({ dni_front: "algo" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('"dni_front" no es un objeto');
  });
});

describe("parseProfileInput", () => {
  it("usa los datos de la cuenta cuando no mandan otros", () => {
    const result = parseProfileInput(undefined, CUENTA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(CUENTA);
  });

  it("permite pisar campos sueltos para probar sin editar el perfil", () => {
    const result = parseProfileInput({ lastName: "Gómez" }, CUENTA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lastName).toBe("Gómez");
    expect(result.data.dni).toBe("12345678");
  });

  it("acepta la fecha en el formato del formulario", () => {
    const result = parseProfileInput({ dateOfBirth: "1985-06-06" }, CUENTA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.dateOfBirth?.toISOString()).toBe(
      "1985-06-06T00:00:00.000Z",
    );
  });

  it("dice cuál campo está mal cuando la fecha no es una fecha", () => {
    const result = parseProfileInput({ dateOfBirth: "ayer" }, CUENTA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("dateOfBirth");
    expect(result.error.message).toContain("ayer");
  });
});

describe("missingProfileFields", () => {
  it("no reporta nada cuando el formulario está completo", () => {
    expect(missingProfileFields(CUENTA)).toEqual([]);
  });

  it("nombra en castellano lo que falta cargar", () => {
    expect(
      missingProfileFields({ ...CUENTA, cuil: null, dateOfBirth: null }),
    ).toEqual(["fecha de nacimiento", "CUIL"]);
  });
});
