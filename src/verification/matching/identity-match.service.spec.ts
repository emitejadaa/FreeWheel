import {
  DocumentExtraction,
  OcrExtraction,
} from "../extraction/extraction.types";
import {
  IdentityMatchService,
  IdentityProfileSnapshot,
  MatchReport,
} from "./identity-match.service";

const NOW = new Date("2026-08-03T12:00:00.000Z");

// Persona sintética coherente en todas las fuentes: DNI 12345678, CUIL
// 20-12345678-6 (checksum válido, prefijo masculino), nacida el 01/02/1990.
const PROFILE: IdentityProfileSnapshot = {
  firstName: "Juan Carlos",
  lastName: "Pérez",
  dateOfBirth: new Date("1990-02-01T00:00:00.000Z"),
  dni: "12345678",
  cuil: "20-12345678-6",
  address: "Av. Siempre Viva 742",
};

function ocr(
  slot: OcrExtraction["classifiedAs"],
  fields: OcrExtraction["fields"] = {},
): OcrExtraction {
  return { classifiedAs: slot, fields };
}

function extraction(
  overrides: Partial<DocumentExtraction> = {},
): DocumentExtraction {
  return {
    dniBarcode: {
      procedureNumber: "00123456789",
      lastName: "PEREZ",
      firstName: "JUAN CARLOS",
      sex: "M",
      dni: "12345678",
      copy: "A",
      birthDate: "1990-02-01",
      issueDate: "2015-03-05",
    },
    mrz: {
      documentNumber: "12345678",
      lastName: "PEREZ",
      firstName: "JUAN CARLOS",
      sex: "M",
      birthDate: "1990-02-01",
      expiryDate: "2030-02-15",
      nationality: "ARG",
      checksumValid: true,
    },
    licenseCode: { dni: "12345678", expiryDate: "2031-05-20", parsed: true },
    ocr: {
      dni_front: ocr("dni_front", {
        nroDocumento: "12.345.678",
        fechaNacimiento: "01/02/1990",
        fechaVencimiento: "15/02/2030",
        sexo: "M",
        apellido: "PEREZ",
        nombre: "JUAN CARLOS",
      }),
      dni_back: ocr("dni_back", {
        domicilio: "AV SIEMPRE VIVA 742 CABA",
        cuil: "20123456786",
        mrzLines: [],
      }),
      license_front: ocr("license_front", {
        apellido: "PEREZ",
        nombre: "JUAN CARLOS",
        nroDocumento: "12345678",
        domicilio: "AV SIEMPRE VIVA 742",
        fechaVencimiento: "20/05/2031",
      }),
      license_back: ocr("license_back", {}),
    },
    ...overrides,
  };
}

function withOcr(
  slot: keyof DocumentExtraction["ocr"],
  patch: OcrExtraction | null,
): Partial<DocumentExtraction> {
  return { ocr: { ...extraction().ocr, [slot]: patch } };
}

function reasonFor(report: MatchReport, code: string) {
  return report.checks.find((check) => check.code === code);
}

describe("IdentityMatchService", () => {
  const service = new IdentityMatchService();
  const run = (
    profile: Partial<IdentityProfileSnapshot> = {},
    overrides: Partial<DocumentExtraction> = {},
  ) => service.match({ ...PROFILE, ...profile }, extraction(overrides), NOW);

  describe("camino feliz", () => {
    it("aprueba cuando todas las fuentes coinciden", () => {
      const report = run();
      expect(report.outcome).toBe("approved");
      expect(report.reasonCodes).toEqual([]);
      expect(report.dniNumber).toBe("12345678");
      expect(report.licenseExpiresAt).toBe("2031-05-20");
    });

    it("no se deja afectar por tildes, puntos ni mayúsculas", () => {
      const report = run({
        firstName: "juan carlos",
        lastName: "perez",
        dni: "12.345.678",
        cuil: "20123456786",
        address: "avenida siempre viva 742",
      });
      expect(report.outcome).toBe("approved");
    });
  });

  describe("rechazos concluyentes", () => {
    it("rechaza si la fecha de nacimiento de la cuenta no coincide", () => {
      const report = run({
        dateOfBirth: new Date("1991-02-01T00:00:00.000Z"),
      });
      expect(report.outcome).toBe("rejected");
      expect(report.reasonCodes).toContain("DOB_MISMATCH");
    });

    it("rechaza si el número de documento no coincide con la cuenta", () => {
      const report = run({ dni: "87654321", cuil: "20876543215" });
      expect(report.outcome).toBe("rejected");
      expect(report.reasonCodes).toContain("DNI_NUMBER_MISMATCH");
    });

    it("rechaza si el apellido no coincide", () => {
      const report = run({ lastName: "Gómez" });
      expect(report.outcome).toBe("rejected");
      expect(report.reasonCodes).toContain("SURNAME_MISMATCH");
    });

    it("rechaza si el nombre de pila es otro", () => {
      const report = run({ firstName: "Pedro" });
      expect(report.outcome).toBe("rejected");
      expect(report.reasonCodes).toContain("GIVEN_NAMES_MISMATCH");
    });

    it("rechaza a un menor de 18 según el documento", () => {
      const minor = extraction();
      minor.dniBarcode!.birthDate = "2010-01-01";
      minor.mrz!.birthDate = "2010-01-01";
      const report = service.match(
        { ...PROFILE, dateOfBirth: new Date("2010-01-01T00:00:00.000Z") },
        minor,
        NOW,
      );
      expect(report.outcome).toBe("rejected");
      expect(report.reasonCodes).toContain("UNDERAGE");
    });

    it("rechaza una licencia vencida", () => {
      const report = run(
        {},
        {
          licenseCode: {
            dni: "12345678",
            expiryDate: "2020-01-01",
            parsed: true,
          },
          ...withOcr(
            "license_front",
            ocr("license_front", {
              apellido: "PEREZ",
              nroDocumento: "12345678",
              fechaVencimiento: "01/01/2020",
            }),
          ),
        },
      );
      expect(report.outcome).toBe("rejected");
      expect(report.reasonCodes).toContain("LICENSE_EXPIRED");
    });

    it("rechaza un DNI vencido", () => {
      const expired = extraction();
      expired.mrz!.expiryDate = "2020-01-01";
      expired.ocr.dni_front!.fields.fechaVencimiento = "01/01/2020";
      const report = service.match(PROFILE, expired, NOW);
      expect(report.outcome).toBe("rejected");
      expect(report.reasonCodes).toContain("DNI_EXPIRED");
    });

    it("rechaza una licencia de otro titular", () => {
      const report = run(
        {},
        {
          licenseCode: {
            dni: "87654321",
            expiryDate: "2031-05-20",
            parsed: true,
          },
          ...withOcr(
            "license_front",
            ocr("license_front", {
              apellido: "PEREZ",
              nroDocumento: "87654321",
              fechaVencimiento: "20/05/2031",
            }),
          ),
        },
      );
      expect(report.outcome).toBe("rejected");
      expect(report.reasonCodes).toContain("LICENSE_DNI_MISMATCH");
    });

    it("rechaza un CUIL con dígito verificador inválido", () => {
      const report = run({ cuil: "20123456787" });
      expect(report.outcome).toBe("rejected");
      expect(report.reasonCodes).toContain("CUIL_INVALID");
    });

    it("rechaza un CUIL que no contiene el DNI del documento", () => {
      // 20-87654321-5 es válido pero pertenece a otro DNI.
      const report = run({ cuil: "20876543215" });
      expect(report.outcome).toBe("rejected");
      expect(report.reasonCodes).toContain("CUIL_DNI_MISMATCH");
    });

    it("rechaza una foto subida en el slot equivocado", () => {
      const report = run({}, withOcr("dni_front", ocr("license_back", {})));
      expect(report.outcome).toBe("rejected");
      expect(report.reasonCodes).toContain("SLOT_CONTENT_MISMATCH");
    });
  });

  describe("casos que van a revisión manual", () => {
    it("queda inconcluso si no se pudo leer el PDF417 ni validar el MRZ", () => {
      const report = run(
        {},
        {
          dniBarcode: null,
          mrz: { ...extraction().mrz!, checksumValid: false },
        },
      );
      expect(report.outcome).toBe("inconclusive");
      expect(report.reasonCodes).toContain("NO_AUTHORITATIVE_SOURCE");
    });

    it("usa el MRZ como ancla cuando el PDF417 no se pudo leer pero el checksum cierra", () => {
      const report = run({}, { dniBarcode: null });
      expect(report.outcome).toBe("approved");
      expect(reasonFor(report, "AUTHORITATIVE_SOURCE")?.detail).toContain(
        "mrz",
      );
    });

    it("nunca aprueba si el PDF417 y un MRZ válido se contradicen", () => {
      const tampered = extraction();
      tampered.mrz!.birthDate = "1985-06-06";
      const report = service.match(PROFILE, tampered, NOW);
      expect(report.outcome).toBe("inconclusive");
      expect(report.reasonCodes).toContain("SOURCE_CONFLICT");
    });

    it("no rechaza por un domicilio escrito distinto, lo manda a revisión", () => {
      const report = run({ address: "Otra Calle 999, Rosario" });
      expect(report.outcome).toBe("inconclusive");
      expect(report.reasonCodes).toContain("ADDRESS_MISMATCH");
    });

    it("manda a revisión cuando el documento trae segundos nombres extra", () => {
      const report = run({ firstName: "Juan" });
      expect(report.outcome).toBe("inconclusive");
      expect(report.reasonCodes).toContain("GIVEN_NAMES_MISMATCH_UNREADABLE");
    });

    it("manda a revisión si no se pudo leer el vencimiento de la licencia", () => {
      const report = run(
        {},
        {
          licenseCode: { dni: "12345678", expiryDate: null, parsed: true },
          ...withOcr(
            "license_front",
            ocr("license_front", {
              apellido: "PEREZ",
              nroDocumento: "12345678",
            }),
          ),
        },
      );
      expect(report.outcome).toBe("inconclusive");
      expect(report.reasonCodes).toContain("LICENSE_EXPIRED_UNREADABLE");
    });

    it("manda a revisión si una foto no se pudo clasificar", () => {
      const report = run({}, withOcr("license_back", ocr("unknown", {})));
      expect(report.outcome).toBe("inconclusive");
      expect(report.reasonCodes).toContain("SLOT_CONTENT_MISMATCH_UNREADABLE");
    });

    it("manda a revisión si faltan los datos manuales de la cuenta", () => {
      const report = run({ cuil: null });
      expect(report.outcome).toBe("inconclusive");
      expect(report.reasonCodes).toContain("CUIL_INVALID_UNREADABLE");
    });

    it("no bloquea cuando el QR de la licencia es opaco", () => {
      const report = run(
        {},
        { licenseCode: { dni: null, expiryDate: null, parsed: false } },
      );
      // El vencimiento sigue disponible por OCR del frente: se aprueba igual.
      expect(report.outcome).toBe("approved");
      expect(reasonFor(report, "LICENSE_CODE_UNAVAILABLE")?.result).toBe(
        "unavailable",
      );
    });

    it("no rechaza por un CUIL con prefijo de excepción (23/24)", () => {
      // 23-12345678-5 es válido; el prefijo 23 no determina sexo.
      const report = run({ cuil: "23123456785" });
      expect(report.outcome).not.toBe("rejected");
      expect(reasonFor(report, "CUIL_SEX_MISMATCH")?.result).toBe(
        "unavailable",
      );
    });
  });

  describe("privacidad del reporte", () => {
    it("los reasonCodes son códigos estables sin datos personales", () => {
      const report = run({ lastName: "Gómez" });
      const serialized = JSON.stringify(report.reasonCodes);
      expect(serialized).not.toContain("Gómez");
      expect(serialized).not.toContain("12345678");
      expect(report.reasonCodes.every((code) => /^[A-Z_]+$/.test(code))).toBe(
        true,
      );
    });

    it("un caso aprobado no expone motivos", () => {
      expect(run().reasonCodes).toEqual([]);
    });
  });
});
