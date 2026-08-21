import {
  DocumentExtraction,
  OcrExtraction,
} from "../extraction/extraction.types";
import {
  IdentityMatchService,
  IdentityProfileSnapshot,
} from "./identity-match.service";

/**
 * RED DE SEGURIDAD PARA REESCRIBIR EL MATCHER
 *
 * El cruce se va a reescribir por dentro para que cada check lea de una matriz
 * de campos (qué dijo cada fuente) en vez de ir a buscar el dato a mano. Es un
 * refactor: no debería cambiar NI UN veredicto.
 *
 * Los tests de `identity-match.service.spec.ts` fijan los casos que importan,
 * pero dejan huecos: nadie ejercita `CUIL_OCR_MISMATCH` en fallo, ni
 * `SEX_MISMATCH`, ni `LICENSE_NAME_MISMATCH`. Este archivo recorre una matriz
 * de escenarios y congela el resultado completo —los 20 checks, no solo el
 * veredicto— para que cualquier corrimiento salte, incluso el que a nadie se
 * le ocurrió testear.
 *
 * Si un cambio mueve este snapshot, hay dos posibilidades: rompiste algo, o
 * cambiaste la política a propósito. Lo segundo se actualiza con -u y se
 * explica en el commit; lo primero se arregla.
 */

const NOW = new Date("2026-08-03T12:00:00.000Z");

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

function baseExtraction(): DocumentExtraction {
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
  };
}

/** Una foto que el modelo no pudo mirar (no es lo mismo que no reconocerla). */
const SIN_OCR: DocumentExtraction["ocr"] = {
  dni_front: null,
  dni_back: null,
  license_front: null,
  license_back: null,
};

interface Escenario {
  nombre: string;
  perfil?: Partial<IdentityProfileSnapshot>;
  /** Recibe la extracción base y la modifica en el lugar. */
  documentos?: (extraction: DocumentExtraction) => void;
}

const ESCENARIOS: Escenario[] = [
  { nombre: "todo coincide" },

  // — Fuentes ausentes —
  {
    nombre: "sin PDF417, con MRZ válido",
    documentos: (e) => {
      e.dniBarcode = null;
    },
  },
  {
    nombre: "sin PDF417 y con MRZ que no cierra",
    documentos: (e) => {
      e.dniBarcode = null;
      e.mrz!.checksumValid = false;
    },
  },
  {
    nombre: "sin OCR en ninguna foto",
    documentos: (e) => {
      e.ocr = { ...SIN_OCR };
      e.mrz = null;
    },
  },
  {
    nombre: "sin OCR y sin código de licencia",
    documentos: (e) => {
      e.ocr = { ...SIN_OCR };
      e.mrz = null;
      e.licenseCode = null;
    },
  },
  {
    nombre: "solo se pudo leer el frente del DNI",
    documentos: (e) => {
      e.ocr = { ...SIN_OCR, dni_front: baseExtraction().ocr.dni_front };
      e.mrz = null;
    },
  },

  // — Contradicciones entre fuentes —
  {
    nombre: "PDF417 y MRZ se contradicen en la fecha de nacimiento",
    documentos: (e) => {
      e.mrz!.birthDate = "1985-06-06";
    },
  },
  {
    nombre: "PDF417 y MRZ se contradicen en el apellido",
    documentos: (e) => {
      e.mrz!.lastName = "GOMEZ";
    },
  },
  {
    nombre: "el OCR del frente lee otro número de documento",
    documentos: (e) => {
      e.ocr.dni_front!.fields.nroDocumento = "87654321";
    },
  },
  {
    nombre: "el OCR del dorso lee otro CUIL",
    documentos: (e) => {
      e.ocr.dni_back!.fields.cuil = "20876543215";
    },
  },
  {
    nombre: "el OCR del frente lee otro sexo",
    documentos: (e) => {
      e.ocr.dni_front!.fields.sexo = "F";
    },
  },
  {
    nombre: "la licencia está a nombre de otra persona",
    documentos: (e) => {
      e.ocr.license_front!.fields.apellido = "GOMEZ";
    },
  },
  {
    nombre: "la licencia corresponde a otro documento",
    documentos: (e) => {
      e.licenseCode = {
        dni: "87654321",
        expiryDate: "2031-05-20",
        parsed: true,
      };
      e.ocr.license_front!.fields.nroDocumento = "87654321";
    },
  },

  // — Vencimientos y edad —
  {
    nombre: "DNI vencido",
    documentos: (e) => {
      e.mrz!.expiryDate = "2020-01-01";
      e.ocr.dni_front!.fields.fechaVencimiento = "01/01/2020";
    },
  },
  {
    nombre: "licencia vencida",
    documentos: (e) => {
      e.licenseCode = {
        dni: "12345678",
        expiryDate: "2020-01-01",
        parsed: true,
      };
      e.ocr.license_front!.fields.fechaVencimiento = "01/01/2020";
    },
  },
  {
    nombre: "no se pudo leer el vencimiento de la licencia",
    documentos: (e) => {
      e.licenseCode = { dni: "12345678", expiryDate: null, parsed: true };
      delete e.ocr.license_front!.fields.fechaVencimiento;
    },
  },
  {
    nombre: "no se pudo leer el vencimiento del DNI",
    documentos: (e) => {
      e.mrz!.checksumValid = false;
      delete e.ocr.dni_front!.fields.fechaVencimiento;
    },
  },
  {
    nombre: "menor de 18 según el documento",
    perfil: { dateOfBirth: new Date("2010-01-01T00:00:00.000Z") },
    documentos: (e) => {
      e.dniBarcode!.birthDate = "2010-01-01";
      e.mrz!.birthDate = "2010-01-01";
      e.ocr.dni_front!.fields.fechaNacimiento = "01/01/2010";
    },
  },

  // — El formulario contra el documento —
  { nombre: "apellido distinto en la cuenta", perfil: { lastName: "Gómez" } },
  { nombre: "nombre de pila distinto", perfil: { firstName: "Pedro" } },
  {
    nombre: "el documento trae un segundo nombre extra",
    perfil: { firstName: "Juan" },
  },
  {
    nombre: "número de documento distinto en la cuenta",
    perfil: { dni: "87654321", cuil: "20876543215" },
  },
  {
    nombre: "fecha de nacimiento distinta en la cuenta",
    perfil: { dateOfBirth: new Date("1991-02-01T00:00:00.000Z") },
  },
  {
    nombre: "domicilio escrito distinto",
    perfil: { address: "Otra Calle 999, Rosario" },
  },
  {
    nombre: "CUIL con dígito verificador inválido",
    perfil: { cuil: "20123456787" },
  },
  { nombre: "CUIL válido pero de otro DNI", perfil: { cuil: "20876543215" } },
  {
    nombre: "CUIL con prefijo que no determina sexo",
    perfil: { cuil: "23123456785" },
  },

  // — Datos que faltan en la cuenta —
  { nombre: "la cuenta no tiene CUIL", perfil: { cuil: null } },
  { nombre: "la cuenta no tiene domicilio", perfil: { address: null } },
  { nombre: "la cuenta no tiene DNI", perfil: { dni: null } },
  {
    nombre: "la cuenta no tiene fecha de nacimiento",
    perfil: { dateOfBirth: null },
  },

  // — Las fotos —
  {
    nombre: "una foto subida en el slot equivocado",
    documentos: (e) => {
      e.ocr.dni_front = ocr("license_back", {});
    },
  },
  {
    nombre: "una foto que el modelo miró y no reconoció",
    documentos: (e) => {
      e.ocr.license_back = ocr("unknown", {});
    },
  },
  {
    nombre: "el QR de la licencia es opaco",
    documentos: (e) => {
      e.licenseCode = { dni: null, expiryDate: null, parsed: false };
    },
  },
];

describe("IdentityMatchService (comportamiento congelado)", () => {
  const service = new IdentityMatchService();

  it.each(ESCENARIOS.map((e) => [e.nombre, e] as const))(
    "%s",
    (_nombre, escenario) => {
      const extraction = baseExtraction();
      escenario.documentos?.(extraction);

      const report = service.match(
        { ...PROFILE, ...escenario.perfil },
        extraction,
        NOW,
      );

      expect({
        outcome: report.outcome,
        reasonCodes: report.reasonCodes,
        documentNumber: report.documentNumber,
        licenseExpiresAt: report.licenseExpiresAt,
        checks: report.checks,
      }).toMatchSnapshot();
    },
  );

  it("cubre los 20 checks que emite el servicio", () => {
    const report = service.match(PROFILE, baseExtraction(), NOW);
    expect(report.checks.map((check) => check.code).sort()).toMatchSnapshot();
  });
});
