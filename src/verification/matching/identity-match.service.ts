import { Injectable } from "@nestjs/common";
import {
  cuilChecksumValid,
  cuilPrefixSex,
  dniMatchesCuil,
  normalizeCuil,
} from "../../common/utils/cuil.util";
import {
  DocumentExtraction,
  DocumentSlot,
  OcrExtraction,
} from "../extraction/extraction.types";
import {
  addressSimilarity,
  ageOn,
  compareNames,
  isNotExpired,
  normalizeDate,
  normalizeDni,
  normalizeSex,
} from "./normalize.util";

/** Datos que el usuario cargó a mano y que los documentos deben confirmar. */
export interface IdentityProfileSnapshot {
  firstName: string;
  lastName: string;
  dateOfBirth: Date | null;
  dni: string | null;
  cuil: string | null;
  address: string | null;
}

export type CheckResult = "pass" | "fail" | "unavailable";

export interface IdentityCheck {
  code: string;
  result: CheckResult;
  /** Contexto breve para el admin; nunca vuelca PII completa. */
  detail?: string;
}

export type IdentityOutcome = "approved" | "rejected" | "inconclusive";

export interface MatchReport {
  outcome: IdentityOutcome;
  checks: IdentityCheck[];
  reasonCodes: string[];
  /** Número de documento de la fuente autoritativa, si la hubo. */
  documentNumber: string | null;
  licenseExpiresAt: string | null;
}

const MIN_AGE = 18;
/** Proporción mínima de tokens compartidos para dar el domicilio por bueno. */
const ADDRESS_MIN_SIMILARITY = 0.5;

/**
 * Checks cuyo FALLO es concluyente: los datos se leyeron bien y no coinciden,
 * o el documento no habilita (menor de edad, vencido). Van a REJECTED.
 * Todo lo demás que no cierre deriva a revisión humana, nunca a un rechazo
 * automático: preferimos molestar a un admin antes que bloquear a una persona
 * real por una foto con brillo.
 */
const HARD_FAIL_CODES = new Set([
  "SLOT_CONTENT_MISMATCH",
  "DNI_NUMBER_MISMATCH",
  "LICENSE_DNI_MISMATCH",
  "SURNAME_MISMATCH",
  "GIVEN_NAMES_MISMATCH",
  "DOB_MISMATCH",
  "UNDERAGE",
  "DNI_EXPIRED",
  "LICENSE_EXPIRED",
  "CUIL_INVALID",
  "CUIL_DNI_MISMATCH",
]);

/**
 * Checks que DEBEN poder evaluarse para aprobar automáticamente: si quedan
 * "unavailable", el caso va a la cola manual.
 */
const REQUIRED_CODES = new Set([
  "AUTHORITATIVE_SOURCE",
  "SLOT_CONTENT_MISMATCH",
  "DNI_NUMBER_MISMATCH",
  "SURNAME_MISMATCH",
  "GIVEN_NAMES_MISMATCH",
  "DOB_MISMATCH",
  "UNDERAGE",
  "DNI_EXPIRED",
  "LICENSE_EXPIRED",
  "LICENSE_DNI_MISMATCH",
  "CUIL_INVALID",
  "CUIL_DNI_MISMATCH",
]);

/** Motivo legible cuando un check requerido no se pudo evaluar. */
const UNREADABLE_REASON: Record<string, string> = {
  AUTHORITATIVE_SOURCE: "NO_AUTHORITATIVE_SOURCE",
};

interface AuthoritativeIdentity {
  dni: string;
  lastName: string;
  firstName: string;
  birthDate: string;
  sex: "M" | "F" | null;
  source: "pdf417" | "mrz";
}

/**
 * Cruza todo lo extraído de los documentos contra sí mismo y contra los datos
 * de la cuenta, y emite un veredicto. Es una función pura (sin IO, sin
 * Prisma, sin red): toda la política de decisión vive acá y se testea con una
 * matriz de casos.
 */
@Injectable()
export class IdentityMatchService {
  match(
    profile: IdentityProfileSnapshot,
    extraction: DocumentExtraction,
    now = new Date(),
  ): MatchReport {
    const checks: IdentityCheck[] = [];
    const authoritative = resolveAuthoritative(extraction);

    checks.push(
      authoritative
        ? {
            code: "AUTHORITATIVE_SOURCE",
            result: "pass",
            detail: `fuente: ${authoritative.source}`,
          }
        : {
            code: "AUTHORITATIVE_SOURCE",
            result: "unavailable",
            detail: "no se pudo leer el PDF417 ni validar el MRZ",
          },
    );

    checks.push(...this.checkSlots(extraction));
    checks.push(this.checkSourceConflict(extraction));
    checks.push(...this.checkDniNumber(profile, extraction, authoritative));
    checks.push(...this.checkNames(profile, extraction, authoritative));
    checks.push(
      ...this.checkBirthDate(profile, extraction, authoritative, now),
    );
    checks.push(this.checkSex(extraction, authoritative));
    checks.push(...this.checkCuil(profile, extraction, authoritative));
    checks.push(this.checkAddress(profile, extraction));
    checks.push(this.checkDniExpiry(extraction, now));
    checks.push(...this.checkLicense(extraction, authoritative, now));

    const outcome = decideOutcome(checks);

    return {
      outcome,
      checks,
      reasonCodes: buildReasonCodes(checks, outcome),
      documentNumber: authoritative?.dni ?? null,
      licenseExpiresAt: licenseExpiry(extraction),
    };
  }

  /** Cada foto debe ser del documento y lado en el que se subió. */
  private checkSlots(extraction: DocumentExtraction): IdentityCheck[] {
    const slots: DocumentSlot[] = [
      "dni_front",
      "dni_back",
      "license_front",
      "license_back",
    ];

    const misplaced = slots.filter((slot) => {
      const classified = extraction.ocr[slot]?.classifiedAs;
      return (
        classified !== undefined &&
        classified !== "unknown" &&
        classified !== slot
      );
    });
    const unreadable = slots.filter((slot) => {
      const classified = extraction.ocr[slot]?.classifiedAs;
      return classified === undefined || classified === "unknown";
    });

    if (misplaced.length > 0) {
      return [
        {
          code: "SLOT_CONTENT_MISMATCH",
          result: "fail",
          detail: `imagen equivocada en: ${misplaced.join(", ")}`,
        },
      ];
    }
    if (unreadable.length > 0) {
      return [
        {
          code: "SLOT_CONTENT_MISMATCH",
          result: "unavailable",
          detail: `no se pudo clasificar: ${unreadable.join(", ")}`,
        },
      ];
    }
    return [{ code: "SLOT_CONTENT_MISMATCH", result: "pass" }];
  }

  /**
   * PDF417 y MRZ válido deben decir lo mismo. Que difieran es señal de
   * adulteración de una de las dos caras: nunca se aprueba solo, va a manual.
   */
  private checkSourceConflict(extraction: DocumentExtraction): IdentityCheck {
    const { dniBarcode, mrz } = extraction;
    if (!dniBarcode || !mrz?.checksumValid) {
      return { code: "SOURCE_CONFLICT", result: "unavailable" };
    }

    const conflicts: string[] = [];
    if (dniBarcode.dni !== mrz.documentNumber) conflicts.push("nro documento");
    if (dniBarcode.birthDate !== mrz.birthDate)
      conflicts.push("fecha nacimiento");
    if (mrz.sex && dniBarcode.sex && mrz.sex !== dniBarcode.sex) {
      conflicts.push("sexo");
    }
    if (compareNames(mrz.lastName, dniBarcode.lastName) === "mismatch") {
      conflicts.push("apellido");
    }

    return conflicts.length > 0
      ? {
          code: "SOURCE_CONFLICT",
          result: "fail",
          detail: `PDF417 y MRZ difieren en: ${conflicts.join(", ")}`,
        }
      : { code: "SOURCE_CONFLICT", result: "pass" };
  }

  private checkDniNumber(
    profile: IdentityProfileSnapshot,
    extraction: DocumentExtraction,
    authoritative: AuthoritativeIdentity | null,
  ): IdentityCheck[] {
    const accountDni = profile.dni ? normalizeDni(profile.dni) : null;
    const ocrDni = readOcrDni(extraction.ocr.dni_front);
    const candidates = [authoritative?.dni, ocrDni, accountDni].filter(
      (value): value is string => Boolean(value),
    );

    const checks: IdentityCheck[] = [];
    if (!authoritative || !accountDni) {
      checks.push({
        code: "DNI_NUMBER_MISMATCH",
        result: "unavailable",
        detail: "falta el número de documento en alguna fuente",
      });
    } else {
      const allEqual = candidates.every((value) => value === candidates[0]);
      checks.push({
        code: "DNI_NUMBER_MISMATCH",
        result: allEqual ? "pass" : "fail",
        detail: allEqual
          ? undefined
          : "el número de documento no coincide entre documento, código y cuenta",
      });
    }

    // La licencia debe pertenecer al mismo titular que el DNI.
    const licenseDni =
      readOcrDni(extraction.ocr.license_front) ??
      extraction.licenseCode?.dni ??
      null;
    if (!authoritative || !licenseDni) {
      checks.push({ code: "LICENSE_DNI_MISMATCH", result: "unavailable" });
    } else {
      checks.push({
        code: "LICENSE_DNI_MISMATCH",
        result: licenseDni === authoritative.dni ? "pass" : "fail",
        detail:
          licenseDni === authoritative.dni
            ? undefined
            : "la licencia corresponde a otro número de documento",
      });
    }

    return checks;
  }

  private checkNames(
    profile: IdentityProfileSnapshot,
    extraction: DocumentExtraction,
    authoritative: AuthoritativeIdentity | null,
  ): IdentityCheck[] {
    if (!authoritative) {
      return [
        { code: "SURNAME_MISMATCH", result: "unavailable" },
        { code: "GIVEN_NAMES_MISMATCH", result: "unavailable" },
      ];
    }

    const checks: IdentityCheck[] = [];

    const surname = compareNames(profile.lastName, authoritative.lastName);
    checks.push({
      code: "SURNAME_MISMATCH",
      result: surname === "mismatch" ? "fail" : "pass",
      detail: surname === "partial" ? "coincidencia parcial" : undefined,
    });

    const given = compareNames(profile.firstName, authoritative.firstName);
    checks.push({
      code: "GIVEN_NAMES_MISMATCH",
      // Parcial (el documento trae segundos nombres) no es fraude, pero
      // tampoco alcanza para aprobar solo: queda para revisión.
      result:
        given === "mismatch"
          ? "fail"
          : given === "partial"
            ? "unavailable"
            : "pass",
      detail:
        given === "partial" ? "coincidencia parcial de nombres" : undefined,
    });

    // La licencia también lleva nombre y apellido impresos.
    const licenseOcr = extraction.ocr.license_front?.fields;
    if (licenseOcr?.apellido) {
      const licenseSurname = compareNames(
        licenseOcr.apellido,
        authoritative.lastName,
      );
      checks.push({
        code: "LICENSE_NAME_MISMATCH",
        result: licenseSurname === "mismatch" ? "fail" : "pass",
      });
    } else {
      checks.push({ code: "LICENSE_NAME_MISMATCH", result: "unavailable" });
    }

    return checks;
  }

  private checkBirthDate(
    profile: IdentityProfileSnapshot,
    extraction: DocumentExtraction,
    authoritative: AuthoritativeIdentity | null,
    now: Date,
  ): IdentityCheck[] {
    const accountBirth = profile.dateOfBirth
      ? profile.dateOfBirth.toISOString().slice(0, 10)
      : null;

    if (!authoritative || !accountBirth) {
      return [
        { code: "DOB_MISMATCH", result: "unavailable" },
        { code: "UNDERAGE", result: "unavailable" },
      ];
    }

    const ocrBirth = normalizeOcrDate(
      extraction.ocr.dni_front?.fields.fechaNacimiento,
    );
    const dates = [authoritative.birthDate, accountBirth, ocrBirth].filter(
      (value): value is string => Boolean(value),
    );
    const allEqual = dates.every((value) => value === dates[0]);

    // La edad se calcula SIEMPRE sobre la fuente autoritativa (el documento),
    // no sobre lo que el usuario declaró.
    const age = ageOn(authoritative.birthDate, now);

    return [
      {
        code: "DOB_MISMATCH",
        result: allEqual ? "pass" : "fail",
        detail: allEqual
          ? undefined
          : "la fecha de nacimiento no coincide entre documento y cuenta",
      },
      {
        code: "UNDERAGE",
        result: age >= MIN_AGE ? "pass" : "fail",
        detail: age >= MIN_AGE ? undefined : `edad ${age}`,
      },
    ];
  }

  private checkSex(
    extraction: DocumentExtraction,
    authoritative: AuthoritativeIdentity | null,
  ): IdentityCheck {
    const ocrSex = extraction.ocr.dni_front?.fields.sexo
      ? normalizeSex(extraction.ocr.dni_front.fields.sexo)
      : null;

    if (!authoritative?.sex || !ocrSex) {
      return { code: "SEX_MISMATCH", result: "unavailable" };
    }
    return {
      code: "SEX_MISMATCH",
      result: authoritative.sex === ocrSex ? "pass" : "fail",
    };
  }

  private checkCuil(
    profile: IdentityProfileSnapshot,
    extraction: DocumentExtraction,
    authoritative: AuthoritativeIdentity | null,
  ): IdentityCheck[] {
    const cuil = profile.cuil ? normalizeCuil(profile.cuil) : null;
    if (!cuil) {
      return [
        { code: "CUIL_INVALID", result: "unavailable" },
        { code: "CUIL_DNI_MISMATCH", result: "unavailable" },
        { code: "CUIL_SEX_MISMATCH", result: "unavailable" },
        { code: "CUIL_OCR_MISMATCH", result: "unavailable" },
      ];
    }

    const checks: IdentityCheck[] = [
      {
        code: "CUIL_INVALID",
        result: cuilChecksumValid(cuil) ? "pass" : "fail",
        detail: cuilChecksumValid(cuil)
          ? undefined
          : "dígito verificador incorrecto",
      },
    ];

    // El CUIL embebe el DNI: comparar contra el documento, no contra lo que
    // el usuario escribió en el campo dni.
    if (!authoritative) {
      checks.push({ code: "CUIL_DNI_MISMATCH", result: "unavailable" });
    } else {
      const matches = dniMatchesCuil(authoritative.dni, cuil);
      checks.push({
        code: "CUIL_DNI_MISMATCH",
        result: matches ? "pass" : "fail",
        detail: matches
          ? undefined
          : "el CUIL no contiene el DNI del documento",
      });
    }

    const prefixSex = cuilPrefixSex(cuil);
    if (!prefixSex || !authoritative?.sex) {
      // Prefijos 23/24/25/26 no determinan sexo: no es un fallo.
      checks.push({ code: "CUIL_SEX_MISMATCH", result: "unavailable" });
    } else {
      checks.push({
        code: "CUIL_SEX_MISMATCH",
        result: prefixSex === authoritative.sex ? "pass" : "fail",
      });
    }

    const printedCuil = extraction.ocr.dni_back?.fields.cuil
      ? normalizeCuil(extraction.ocr.dni_back.fields.cuil)
      : null;
    checks.push(
      printedCuil
        ? {
            code: "CUIL_OCR_MISMATCH",
            result: printedCuil === cuil ? "pass" : "fail",
          }
        : { code: "CUIL_OCR_MISMATCH", result: "unavailable" },
    );

    return checks;
  }

  /**
   * El domicilio se imprime con formatos muy distintos según el documento, así
   * que se compara por similitud y NUNCA rechaza por sí solo: como mucho manda
   * el caso a revisión humana.
   */
  private checkAddress(
    profile: IdentityProfileSnapshot,
    extraction: DocumentExtraction,
  ): IdentityCheck {
    const documentAddress =
      extraction.ocr.dni_back?.fields.domicilio ??
      extraction.ocr.license_front?.fields.domicilio ??
      null;

    if (!profile.address || !documentAddress) {
      return { code: "ADDRESS_MISMATCH", result: "unavailable" };
    }

    const similarity = addressSimilarity(profile.address, documentAddress);
    return {
      code: "ADDRESS_MISMATCH",
      result: similarity >= ADDRESS_MIN_SIMILARITY ? "pass" : "fail",
      detail: `similitud ${similarity.toFixed(2)}`,
    };
  }

  private checkDniExpiry(
    extraction: DocumentExtraction,
    now: Date,
  ): IdentityCheck {
    const expiry =
      (extraction.mrz?.checksumValid ? extraction.mrz.expiryDate : null) ??
      normalizeOcrDate(extraction.ocr.dni_front?.fields.fechaVencimiento);

    if (!expiry) return { code: "DNI_EXPIRED", result: "unavailable" };

    return {
      code: "DNI_EXPIRED",
      result: isNotExpired(expiry, now) ? "pass" : "fail",
      detail: isNotExpired(expiry, now) ? undefined : `vencido el ${expiry}`,
    };
  }

  private checkLicense(
    extraction: DocumentExtraction,
    _authoritative: AuthoritativeIdentity | null,
    now: Date,
  ): IdentityCheck[] {
    const expiry = licenseExpiry(extraction);
    const checks: IdentityCheck[] = [
      expiry
        ? {
            code: "LICENSE_EXPIRED",
            result: isNotExpired(expiry, now) ? "pass" : "fail",
            detail: isNotExpired(expiry, now)
              ? undefined
              : `vencida el ${expiry}`,
          }
        : {
            code: "LICENSE_EXPIRED",
            result: "unavailable",
            detail: "no se pudo leer el vencimiento de la licencia",
          },
    ];

    // Informativo: el QR de la licencia no está estandarizado y muchas
    // jurisdicciones sólo publican un identificador opaco.
    checks.push({
      code: "LICENSE_CODE_UNAVAILABLE",
      result: extraction.licenseCode?.parsed ? "pass" : "unavailable",
    });

    return checks;
  }
}

/**
 * Ancla de identidad: el PDF417 primero (lo imprime el RENAPER y lo lee un
 * decodificador, no un modelo) y el MRZ como respaldo solo si sus check
 * digits cierran.
 */
function resolveAuthoritative(
  extraction: DocumentExtraction,
): AuthoritativeIdentity | null {
  const { dniBarcode, mrz } = extraction;

  if (dniBarcode) {
    return {
      dni: dniBarcode.dni,
      lastName: dniBarcode.lastName,
      firstName: dniBarcode.firstName,
      birthDate: dniBarcode.birthDate,
      sex: dniBarcode.sex,
      source: "pdf417",
    };
  }

  if (mrz?.checksumValid) {
    return {
      dni: mrz.documentNumber,
      lastName: mrz.lastName,
      firstName: mrz.firstName,
      birthDate: mrz.birthDate,
      sex: mrz.sex,
      source: "mrz",
    };
  }

  return null;
}

function licenseExpiry(extraction: DocumentExtraction): string | null {
  return (
    normalizeOcrDate(extraction.ocr.license_front?.fields.fechaVencimiento) ??
    extraction.licenseCode?.expiryDate ??
    null
  );
}

function readOcrDni(ocr: OcrExtraction | null | undefined): string | null {
  const raw = ocr?.fields.nroDocumento;
  return raw ? normalizeDni(raw) : null;
}

function normalizeOcrDate(value: string | undefined): string | null {
  return value ? normalizeDate(value) : null;
}

function decideOutcome(checks: IdentityCheck[]): IdentityOutcome {
  const failed = checks.filter((check) => check.result === "fail");

  if (failed.some((check) => HARD_FAIL_CODES.has(check.code))) {
    return "rejected";
  }
  if (failed.length > 0) return "inconclusive";

  const missingRequired = checks.some(
    (check) => check.result === "unavailable" && REQUIRED_CODES.has(check.code),
  );
  return missingRequired ? "inconclusive" : "approved";
}

/**
 * Motivos que se le muestran al usuario: solo códigos estables, sin datos
 * personales. Un caso aprobado no expone nada.
 */
function buildReasonCodes(
  checks: IdentityCheck[],
  outcome: IdentityOutcome,
): string[] {
  if (outcome === "approved") return [];

  const codes = checks
    .filter((check) => check.result === "fail")
    .map((check) => check.code);

  if (outcome === "inconclusive") {
    codes.push(
      ...checks
        .filter(
          (check) =>
            check.result === "unavailable" && REQUIRED_CODES.has(check.code),
        )
        .map(
          (check) =>
            UNREADABLE_REASON[check.code] ?? `${check.code}_UNREADABLE`,
        ),
    );
    if (codes.length === 0) codes.push("MANUAL_REVIEW_REQUIRED");
  }

  return [...new Set(codes)];
}
