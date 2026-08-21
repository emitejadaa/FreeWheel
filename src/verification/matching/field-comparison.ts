import { normalizeCuil } from "../../common/utils/cuil.util";
import { DocumentExtraction } from "../extraction/extraction.types";
import {
  addressSimilarity,
  compareNames,
  normalizeDate,
  normalizeDni,
  normalizeSex,
  normalizeText,
} from "./normalize.util";
import type { IdentityProfileSnapshot } from "./identity-match.service";

/**
 * MÓDULO 3 · la comparación, campo por campo y fuente por fuente.
 *
 * Esto NO decide nada: describe. Para cada dato del documento junta lo que dice
 * cada fuente —lo que la persona cargó en el formulario, lo que está impreso y
 * leyó el modelo, lo que trae el código de barras, lo que trae el MRZ— y dice
 * si coinciden. Qué hacer con un desacuerdo (rechazar, mandar a revisión,
 * ignorar) es política, y vive en IdentityMatchService.
 *
 * Separarlo tiene dos razones concretas: se puede testear con una tabla de
 * casos sin tocar nada más, y se puede mostrar entero en pantalla. "El apellido
 * no coincide" no le sirve a nadie; "el formulario dice PEREZ, el PDF417 dice
 * PEREZ y el OCR de la licencia dice PEREÍ" se arregla solo.
 */

/** Los datos que se cruzan entre sí. */
export type ComparableField =
  | "lastName"
  | "firstName"
  | "documentNumber"
  | "birthDate"
  | "sex"
  | "cuil"
  | "address"
  | "dniExpiry"
  | "licenseExpiry";

/** De dónde puede salir cada dato. */
export type EvidenceSource =
  | "form"
  | "pdf417_dni"
  | "mrz"
  | "license_code"
  | "ocr_dni_front"
  | "ocr_dni_back"
  | "ocr_license_front"
  | "ocr_license_back";

/** Cómo se llama cada fuente cuando hay que mostrarla. */
export const SOURCE_LABELS: Record<EvidenceSource, string> = {
  form: "el formulario de la cuenta",
  pdf417_dni: "el código PDF417 del DNI",
  mrz: "el MRZ del dorso del DNI",
  license_code: "el código de la licencia",
  ocr_dni_front: "el texto del frente del DNI",
  ocr_dni_back: "el texto del dorso del DNI",
  ocr_license_front: "el texto del frente de la licencia",
  ocr_license_back: "el texto del dorso de la licencia",
};

/**
 * Las fuentes que NO escribe un modelo. El PDF417 y el MRZ los imprime el
 * organismo emisor y los lee un decodificador; el formulario lo escribió la
 * persona. Todo lo que empieza con `ocr_` lo transcribió un modelo de visión y
 * puede tener errores de lectura.
 */
const DETERMINISTIC: ReadonlySet<EvidenceSource> = new Set([
  "form",
  "pdf417_dni",
  "mrz",
  "license_code",
]);

export interface FieldObservation {
  source: EvidenceSource;
  /** Tal cual está escrito en esa fuente. */
  raw: string;
  /** Normalizado para poder compararlo; null si no se pudo interpretar. */
  normalized: string | null;
  trusted: boolean;
}

export type FieldStatus = "agree" | "conflict" | "single-source" | "missing";

/**
 * "compatible" es el caso del nombre: el documento dice "JUAN CARLOS" y el
 * formulario "JUAN". No es lo mismo, pero tampoco es otra persona.
 */
export type ComparisonVerdict = "equal" | "compatible" | "different";

export interface FieldConflict {
  a: EvidenceSource;
  b: EvidenceSource;
  verdict: Exclude<ComparisonVerdict, "equal">;
  detail: string;
}

export interface FieldComparison {
  field: ComparableField;
  status: FieldStatus;
  observations: FieldObservation[];
  conflicts: FieldConflict[];
  /** El valor que se toma por bueno, y de dónde salió. */
  resolved: { value: string; source: EvidenceSource } | null;
  /** Solo para el domicilio, que se compara por parecido y no por igualdad. */
  similarity?: number;
}

export type FieldMatrix = Record<ComparableField, FieldComparison>;

/**
 * Qué fuente gana cuando varias tienen el dato. NO es por mayoría: es por
 * confiabilidad, declarada acá y no escondida en un `??` en el medio de un if.
 *
 * Las dos asimetrías que importan y que antes había que ir a buscar al código:
 * el vencimiento del DNI sale del MRZ antes que del texto impreso, y el de la
 * licencia sale del texto impreso antes que del código.
 */
export const FIELD_PRECEDENCE: Readonly<
  Record<ComparableField, readonly EvidenceSource[]>
> = {
  lastName: ["pdf417_dni", "mrz", "ocr_dni_front", "ocr_license_front", "form"],
  firstName: [
    "pdf417_dni",
    "mrz",
    "ocr_dni_front",
    "ocr_license_front",
    "form",
  ],
  documentNumber: [
    "pdf417_dni",
    "mrz",
    "ocr_dni_front",
    "license_code",
    "ocr_license_front",
    "form",
  ],
  birthDate: [
    "pdf417_dni",
    "mrz",
    "ocr_dni_front",
    "ocr_license_front",
    "form",
  ],
  sex: ["pdf417_dni", "mrz", "ocr_dni_front"],
  cuil: ["form", "ocr_dni_back"],
  address: ["form", "ocr_dni_back", "ocr_license_front"],
  dniExpiry: ["mrz", "ocr_dni_front"],
  licenseExpiry: ["ocr_license_front", "license_code", "ocr_license_back"],
};

/** Cómo se normaliza cada campo antes de compararlo. */
const NORMALIZERS: Record<ComparableField, (raw: string) => string | null> = {
  lastName: (raw) => nonEmpty(normalizeText(raw)),
  firstName: (raw) => nonEmpty(normalizeText(raw)),
  documentNumber: normalizeDni,
  birthDate: normalizeDate,
  sex: normalizeSex,
  cuil: normalizeCuil,
  address: (raw) => nonEmpty(normalizeText(raw)),
  dniExpiry: normalizeDate,
  licenseExpiry: normalizeDate,
};

/** Proporción mínima de palabras compartidas para dar el domicilio por bueno. */
export const ADDRESS_MIN_SIMILARITY = 0.5;

/** Cómo se decide si dos valores del mismo campo son "el mismo dato". */
const COMPARATORS: Partial<
  Record<ComparableField, (a: string, b: string) => ComparisonVerdict>
> = {
  // Los nombres casi nunca se escriben igual en dos documentos: uno pone los
  // dos nombres de pila y el otro solo el primero.
  lastName: nameVerdict,
  firstName: nameVerdict,
  address: (a, b) => {
    if (a === b) return "equal";
    return addressSimilarity(a, b) >= ADDRESS_MIN_SIMILARITY
      ? "compatible"
      : "different";
  },
};

function nameVerdict(a: string, b: string): ComparisonVerdict {
  const resultado = compareNames(a, b);
  if (resultado === "match") return "equal";
  return resultado === "partial" ? "compatible" : "different";
}

function nonEmpty(value: string): string | null {
  return value.length > 0 ? value : null;
}

/** Junta lo que dice cada fuente y las compara entre sí. */
export function buildFieldMatrix(
  profile: IdentityProfileSnapshot,
  extraction: DocumentExtraction,
): FieldMatrix {
  const observaciones = collectObservations(profile, extraction);

  const matrix = {} as FieldMatrix;
  for (const field of Object.keys(NORMALIZERS) as ComparableField[]) {
    matrix[field] = compareField(field, observaciones[field] ?? []);
  }
  return matrix;
}

/** Un campo de la matriz, ya comparado. Expuesto para poder testearlo solo. */
export function compareField(
  field: ComparableField,
  observations: FieldObservation[],
): FieldComparison {
  const utiles = observations.filter((obs) => obs.normalized !== null);
  const comparar =
    COMPARATORS[field] ??
    ((a: string, b: string) => (a === b ? "equal" : "different"));

  const conflicts: FieldConflict[] = [];
  for (let i = 0; i < utiles.length; i += 1) {
    for (let j = i + 1; j < utiles.length; j += 1) {
      const a = utiles[i];
      const b = utiles[j];
      const verdict = comparar(a.normalized!, b.normalized!);
      if (verdict === "equal") continue;

      conflicts.push({
        a: a.source,
        b: b.source,
        verdict,
        detail:
          `${SOURCE_LABELS[a.source]} dice "${a.raw}" y ` +
          `${SOURCE_LABELS[b.source]} dice "${b.raw}"`,
      });
    }
  }

  const hayContradiccion = conflicts.some((c) => c.verdict === "different");
  const status: FieldStatus =
    utiles.length === 0
      ? "missing"
      : hayContradiccion
        ? "conflict"
        : utiles.length === 1
          ? "single-source"
          : "agree";

  const preferida = FIELD_PRECEDENCE[field]
    .map((source) => utiles.find((obs) => obs.source === source))
    .find(Boolean);

  const comparison: FieldComparison = {
    field,
    status,
    observations,
    conflicts,
    resolved: preferida
      ? { value: preferida.normalized!, source: preferida.source }
      : null,
  };

  if (field === "address" && utiles.length >= 2) {
    comparison.similarity = addressSimilarity(
      utiles[0].normalized!,
      utiles[1].normalized!,
    );
  }

  return comparison;
}

type Observations = Partial<Record<ComparableField, FieldObservation[]>>;

/** Dónde vive cada dato dentro de todo lo que se extrajo. */
function collectObservations(
  profile: IdentityProfileSnapshot,
  extraction: DocumentExtraction,
): Observations {
  const observaciones: Observations = {};

  const add = (
    field: ComparableField,
    source: EvidenceSource,
    raw: string | null | undefined,
  ) => {
    if (raw === null || raw === undefined) return;
    const texto = String(raw).trim();
    if (texto.length === 0) return;

    (observaciones[field] ??= []).push({
      source,
      raw: texto,
      normalized: NORMALIZERS[field](texto),
      trusted: DETERMINISTIC.has(source),
    });
  };

  // Lo que la persona cargó a mano. La cuenta no guarda el sexo, por eso no
  // aparece como fuente para ese campo.
  add("lastName", "form", profile.lastName);
  add("firstName", "form", profile.firstName);
  add("documentNumber", "form", profile.dni);
  add("cuil", "form", profile.cuil);
  add("address", "form", profile.address);
  add(
    "birthDate",
    "form",
    profile.dateOfBirth ? profile.dateOfBirth.toISOString().slice(0, 10) : null,
  );

  // El código del RENAPER: la fuente más confiable, y no la escribe un modelo.
  const { dniBarcode, mrz, licenseCode, ocr } = extraction;
  if (dniBarcode) {
    add("lastName", "pdf417_dni", dniBarcode.lastName);
    add("firstName", "pdf417_dni", dniBarcode.firstName);
    add("documentNumber", "pdf417_dni", dniBarcode.dni);
    add("birthDate", "pdf417_dni", dniBarcode.birthDate);
    add("sex", "pdf417_dni", dniBarcode.sex);
  }

  // El MRZ solo cuenta si sus dígitos verificadores cierran: si no, lo más
  // probable es que esté mal transcripto, y una fuente mal transcripta genera
  // contradicciones que no existen.
  if (mrz?.checksumValid) {
    add("lastName", "mrz", mrz.lastName);
    add("firstName", "mrz", mrz.firstName);
    add("documentNumber", "mrz", mrz.documentNumber);
    add("birthDate", "mrz", mrz.birthDate);
    add("sex", "mrz", mrz.sex);
    add("dniExpiry", "mrz", mrz.expiryDate);
  }

  if (licenseCode) {
    add("documentNumber", "license_code", licenseCode.dni);
    add("licenseExpiry", "license_code", licenseCode.expiryDate);
  }

  const frenteDni = ocr.dni_front?.fields;
  add("lastName", "ocr_dni_front", frenteDni?.apellido);
  add("firstName", "ocr_dni_front", frenteDni?.nombre);
  add("documentNumber", "ocr_dni_front", frenteDni?.nroDocumento);
  add("birthDate", "ocr_dni_front", frenteDni?.fechaNacimiento);
  add("sex", "ocr_dni_front", frenteDni?.sexo);
  add("dniExpiry", "ocr_dni_front", frenteDni?.fechaVencimiento);

  const dorsoDni = ocr.dni_back?.fields;
  add("address", "ocr_dni_back", dorsoDni?.domicilio);
  add("cuil", "ocr_dni_back", dorsoDni?.cuil);

  const frenteLic = ocr.license_front?.fields;
  add("lastName", "ocr_license_front", frenteLic?.apellido);
  add("firstName", "ocr_license_front", frenteLic?.nombre);
  add("documentNumber", "ocr_license_front", frenteLic?.nroDocumento);
  add("birthDate", "ocr_license_front", frenteLic?.fechaNacimiento);
  add("address", "ocr_license_front", frenteLic?.domicilio);
  add("licenseExpiry", "ocr_license_front", frenteLic?.fechaVencimiento);

  const dorsoLic = ocr.license_back?.fields;
  add("licenseExpiry", "ocr_license_back", dorsoLic?.fechaVencimiento);

  return observaciones;
}
