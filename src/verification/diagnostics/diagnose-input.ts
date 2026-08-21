import {
  ParseResult,
  parseFail,
  parseOk,
  sample,
  verificationError,
} from "../errors/verification-errors";
import { tryParseDniPdf417 } from "../extraction/dni-pdf417.parser";
import {
  DocumentExtraction,
  DocumentSlot,
  OcrExtraction,
  OcrFields,
} from "../extraction/extraction.types";
import { tryParseLicenseCode } from "../extraction/license-code.parser";
import { tryParseMrzTd1 } from "../extraction/mrz-td1.parser";
import { CanonicalField } from "../extraction/ocr/ocr.types";
import { IdentityProfileSnapshot } from "../matching/identity-match.service";

const SLOTS: DocumentSlot[] = [
  "dni_front",
  "dni_back",
  "license_front",
  "license_back",
];

/** Los campos del OCR, en el nombre plano que consume el cruce. */
const FLAT_KEY: Partial<Record<CanonicalField, keyof OcrFields>> = {
  lastName: "apellido",
  firstName: "nombre",
  sex: "sexo",
  documentNumber: "nroDocumento",
  birthDate: "fechaNacimiento",
  expiryDate: "fechaVencimiento",
  address: "domicilio",
  cuil: "cuil",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Rearma lo extraído a partir de lo que devolvió el diagnóstico foto por foto.
 *
 * IMPORTANTE: los códigos se vuelven a interpretar acá desde su payload CRUDO,
 * no se confía en el objeto ya parseado que manda el cliente. Así la
 * comparación es de verdad la del backend —la misma que corre en la
 * verificación real— y no algo que se pueda inducir mandando datos armados.
 */
export function buildExtractionFromDiagnoses(
  documents: unknown,
): ParseResult<DocumentExtraction> {
  if (!isRecord(documents)) {
    return parseFail(
      verificationError("EXTRACTION_INPUT_INVALID", {
        cause: "se esperaba un objeto con una clave por documento",
      }),
    );
  }

  const conocidos = SLOTS.filter((slot) => documents[slot] !== undefined);
  if (conocidos.length === 0) {
    return parseFail(
      verificationError("EXTRACTION_INPUT_INVALID", {
        cause: `ninguna de las claves esperadas (${SLOTS.join(", ")})`,
      }),
    );
  }

  const ocr: DocumentExtraction["ocr"] = {};
  const payloads: string[] = [];

  for (const slot of conocidos) {
    const documento = documents[slot];
    if (!isRecord(documento)) {
      return parseFail(
        verificationError("EXTRACTION_INPUT_INVALID", {
          cause: `"${slot}" no es un objeto`,
        }),
      );
    }

    ocr[slot] = readOcr(documento.ocr);
    payloads.push(...readPayloads(documento.codes));
  }

  // El PDF417 del RENAPER y el código de la licencia salen de los payloads,
  // sin importar en qué foto aparecieron.
  const dniBarcode =
    payloads.map((payload) => tryParseDniPdf417(payload)).find((r) => r.ok) ??
    null;

  const licenciaPayload = payloads.find(
    (payload) => !tryParseDniPdf417(payload).ok,
  );
  const licenseCode = licenciaPayload
    ? tryParseLicenseCode(licenciaPayload)
    : null;

  const mrzLines = readMrzLines(documents.dni_back);
  const mrz = mrzLines.length > 0 ? tryParseMrzTd1(mrzLines) : null;

  return parseOk({
    dniBarcode: dniBarcode?.ok ? dniBarcode.data : null,
    mrz: mrz?.ok ? mrz.data : null,
    licenseCode: licenseCode?.ok ? licenseCode.data : null,
    ocr,
    schema: 2,
  });
}

/** Los payloads crudos de los códigos que se leyeron en una foto. */
function readPayloads(codes: unknown): string[] {
  if (!isRecord(codes) || !Array.isArray(codes.codes)) return [];
  return codes.codes
    .map((code) => (isRecord(code) ? asString(code.payload) : null))
    .filter((payload): payload is string => payload !== null);
}

/** Baja una lectura del OCR a la forma plana que consume el cruce. */
function readOcr(value: unknown): OcrExtraction | null {
  if (!isRecord(value)) return null;

  const fields: OcrFields = {};
  if (isRecord(value.fields)) {
    for (const [nombre, contenido] of Object.entries(value.fields)) {
      const plano = FLAT_KEY[nombre as CanonicalField];
      if (!plano || plano === "mrzLines") continue;

      // Se toma el texto CRUDO: el cruce normaliza por su cuenta.
      const raw = isRecord(contenido)
        ? (asString(contenido.raw) ?? asString(contenido.value))
        : asString(contenido);
      if (raw) fields[plano] = raw;
    }
  }

  const mrzLines = Array.isArray(value.mrzLines)
    ? value.mrzLines
        .map((linea) => asString(linea))
        .filter((linea): linea is string => linea !== null)
    : [];
  if (mrzLines.length > 0) fields.mrzLines = mrzLines;

  const classifiedAs = asString(value.classifiedAs);
  return {
    classifiedAs:
      classifiedAs && SLOTS.includes(classifiedAs as DocumentSlot)
        ? (classifiedAs as DocumentSlot)
        : "unknown",
    fields,
  };
}

function readMrzLines(dniBack: unknown): string[] {
  if (!isRecord(dniBack)) return [];
  const ocr = readOcr(dniBack.ocr);
  return ocr?.fields.mrzLines ?? [];
}

/**
 * Los datos del formulario contra los que se compara.
 *
 * Si no vienen, se usan los de la cuenta. Poder mandarlos a mano es lo que
 * permite probar la comparación sin tener que editar el perfil cada vez.
 */
export function parseProfileInput(
  value: unknown,
  fallback: IdentityProfileSnapshot,
): ParseResult<IdentityProfileSnapshot> {
  if (value === undefined || value === null) return parseOk(fallback);
  if (!isRecord(value)) {
    return parseFail(
      verificationError("EXTRACTION_INPUT_INVALID", {
        cause: '"profile" no es un objeto',
      }),
    );
  }

  const fecha = asString(value.dateOfBirth);
  let dateOfBirth = fallback.dateOfBirth;
  if (fecha !== null) {
    const parsed = new Date(
      /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? `${fecha}T00:00:00.000Z` : fecha,
    );
    if (Number.isNaN(parsed.getTime())) {
      return parseFail(
        verificationError("EXTRACTION_INPUT_INVALID", {
          cause: `"dateOfBirth" no es una fecha: ${sample(fecha, 20)}`,
        }),
      );
    }
    dateOfBirth = parsed;
  }

  return parseOk({
    firstName: asString(value.firstName) ?? fallback.firstName,
    lastName: asString(value.lastName) ?? fallback.lastName,
    dni: asString(value.dni) ?? fallback.dni,
    cuil: asString(value.cuil) ?? fallback.cuil,
    address: asString(value.address) ?? fallback.address,
    dateOfBirth,
  });
}

/** Qué datos del formulario faltan para poder comparar contra el documento. */
export function missingProfileFields(
  profile: IdentityProfileSnapshot,
): string[] {
  const faltan: string[] = [];
  if (!profile.firstName?.trim()) faltan.push("nombre");
  if (!profile.lastName?.trim()) faltan.push("apellido");
  if (!profile.dateOfBirth) faltan.push("fecha de nacimiento");
  if (!profile.dni) faltan.push("DNI");
  if (!profile.cuil) faltan.push("CUIL");
  if (!profile.address) faltan.push("domicilio");
  return faltan;
}
