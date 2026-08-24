import { Injectable } from "@nestjs/common";
import {
  cuilChecksumValid,
  cuilPrefixSex,
  dniMatchesCuil,
  normalizeCuil,
} from "../../common/utils/cuil.util";
import {
  DniDocverifyResult,
  LicenseDocverifyResult,
} from "../docverify/docverify.types";
import {
  VerificationReason,
  verificationReason,
} from "../errors/verification-reasons";
import {
  addressSimilarity,
  ageOn,
  compareNames,
  compareNamesOcr,
  isNotExpired,
  normalizeDate,
  normalizeDni,
  normalizeSex,
} from "./normalize.util";

/** Datos que la persona cargó a mano y que los documentos deben confirmar. */
export interface IdentityProfileSnapshot {
  firstName: string;
  lastName: string;
  dateOfBirth: Date | null;
  dni: string | null;
  cuil: string | null;
  address: string | null;
}

/** Proporción mínima de tokens compartidos para dar el domicilio por bueno. */
const ADDRESS_MIN_SIMILARITY = 0.5;
const MIN_AGE = 18;

/** Una fila de la matriz de evidencia: qué dijo cada fuente sobre un campo. */
export interface FieldMatrixRow {
  field: string;
  readings: Record<string, string | boolean | null>;
  status: "ok" | "vacio" | "conflicto" | "advertencia";
}

export interface DocumentMatchResult {
  approved: boolean;
  /** Por qué NO se aprueba, en mensajes aptos para el usuario. Vacío si ok. */
  reasons: VerificationReason[];
  /** Evidencia campo por campo, para el admin. Puede traer datos leídos. */
  matrix: FieldMatrixRow[];
  documentNumber: string | null;
  /** Vencimiento del documento, ISO AAAA-MM-DD. */
  expiresAt: string | null;
}

/**
 * LA POLÍTICA DE DECISIÓN, EN UN SOLO LUGAR
 *
 * Cruza lo que devolvió el verificador Python contra sí mismo (protocolo
 * contra protocolo) y contra los datos de la cuenta, y decide si el
 * documento se aprueba solo. Función pura: sin IO, sin Prisma, sin red.
 *
 * La regla, acordada con producto:
 * - TODO dato del documento debe quedar determinado (leído por al menos un
 *   protocolo) y TODAS las lecturas del mismo dato deben coincidir entre sí
 *   y con la cuenta. Un dato vacío o en conflicto frena la aprobación con
 *   un motivo que dice exactamente qué y dónde.
 * - En el DNI, los dos protocolos ancla (PDF417 y MRZ) son obligatorios:
 *   son los únicos verificables mecánicamente (separador @ del RENAPER,
 *   dígitos verificadores ICAO).
 * - Los nombres leídos por óptica (OCR y la línea de nombres del MRZ, que
 *   no tiene dígito verificador) toleran UN caracter mal transcripto por
 *   token; el PDF417 y el formulario se comparan exactos.
 * - El domicilio se compara por similitud y con mensajes más suaves: los
 *   formatos impresos varían tanto que un conflicto suele ser formato, no
 *   fraude. Igual frena la aprobación automática (lo destraba un admin).
 * - Vigencias: documento no vencido, mayor de edad, y el período de
 *   principiante de la licencia ya cumplido.
 */
@Injectable()
export class DocumentMatchService {
  matchDni(
    profile: IdentityProfileSnapshot,
    result: DniDocverifyResult,
    now = new Date(),
  ): DocumentMatchResult {
    const reasons: VerificationReason[] = [];
    const matrix: FieldMatrixRow[] = [];

    const front = result.dni_front;
    const back = result.dni_back;

    if (front.error) {
      reasons.push(
        verificationReason("FOTO_NO_PROCESABLE", {
          slot: "dni_front",
          detail: front.error.message,
        }),
      );
    }
    if (back.error) {
      reasons.push(
        verificationReason("FOTO_NO_PROCESABLE", {
          slot: "dni_back",
          detail: back.error.message,
        }),
      );
    }

    // Los dos protocolos ancla son obligatorios.
    const codigoOk = !front.codigo.error && Boolean(front.codigo.nDocumento);
    if (!codigoOk && !front.error) {
      reasons.push(verificationReason("CODIGO_NO_LEIDO"));
    }
    const mrzOk = !back.mrz.error && Boolean(back.mrz.nDocumento);
    if (!mrzOk && !back.error) {
      reasons.push(verificationReason("MRZ_NO_LEIDO"));
    }

    // ── Apellido y nombre ────────────────────────────────────────────────
    this.checkName(reasons, matrix, "apellido", profile.lastName, [
      { source: "ocr dni_front", value: front.ocr.apellido, tolerant: true },
      { source: "codigo", value: front.codigo.apellido, tolerant: false },
      { source: "mrz", value: back.mrz.apellido, tolerant: true },
    ]);
    this.checkName(reasons, matrix, "nombre", profile.firstName, [
      { source: "ocr dni_front", value: front.ocr.nombre, tolerant: true },
      { source: "codigo", value: front.codigo.nombre, tolerant: false },
      { source: "mrz", value: back.mrz.nombre, tolerant: true },
    ]);

    // ── Sexo (no está en la cuenta: se cruza entre protocolos y el CUIL) ─
    const sexes = this.checkEqual(reasons, matrix, {
      field: "sexo",
      slot: "dni_front",
      account: null,
      readings: [
        { source: "ocr dni_front", value: normalizeSex(front.ocr.sexo ?? "") },
        { source: "codigo", value: normalizeSex(front.codigo.sexo ?? "") },
        { source: "mrz", value: normalizeSex(back.mrz.sexo ?? "") },
      ],
    });

    // ── Número de documento ──────────────────────────────────────────────
    const accountDni = profile.dni ? normalizeDni(profile.dni) : null;
    const dniAgreed = this.checkEqual(reasons, matrix, {
      field: "nDocumento",
      slot: "dni_front",
      account: accountDni,
      readings: [
        {
          source: "ocr dni_front",
          value: normalizeDni(front.ocr.nDocumento ?? ""),
        },
        {
          source: "codigo",
          value: normalizeDni(front.codigo.nDocumento ?? ""),
        },
        { source: "mrz", value: normalizeDni(back.mrz.nDocumento ?? "") },
      ],
    });

    // ── Fecha de nacimiento y mayoría de edad ────────────────────────────
    const accountBirth = profile.dateOfBirth
      ? profile.dateOfBirth.toISOString().slice(0, 10)
      : null;
    const birthReadings = [
      {
        source: "ocr dni_front",
        value: normalizeDate(front.ocr.fechaNacimiento ?? ""),
      },
      {
        source: "codigo",
        value: normalizeDate(front.codigo.fechaNacimiento ?? ""),
      },
      { source: "mrz", value: normalizeDate(back.mrz.fechaNacimiento ?? "") },
    ];
    this.checkEqual(reasons, matrix, {
      field: "fechaNacimiento",
      slot: "dni_front",
      account: accountBirth,
      readings: birthReadings,
    });
    // La edad se calcula sobre lo que dice el DOCUMENTO, y se evalúa aunque
    // ese dato NO coincida con la cuenta: un documento que dice que la
    // persona es menor tiene que decirlo con ese motivo, no esconderse
    // detrás de un genérico "no coincide".
    this.checkAge(reasons, birthReadings, now);

    // ── Fecha de emisión ─────────────────────────────────────────────────
    this.checkEqual(reasons, matrix, {
      field: "fechaEmision",
      slot: "dni_front",
      account: null,
      readings: [
        {
          source: "ocr dni_front",
          value: normalizeDate(front.ocr.fechaEmision ?? ""),
        },
        {
          source: "codigo",
          value: normalizeDate(front.codigo.fechaEmision ?? ""),
        },
      ],
    });

    // ── Vencimiento del DNI ──────────────────────────────────────────────
    const expiry = this.checkEqual(reasons, matrix, {
      field: "fechaVencimiento",
      slot: "dni_front",
      account: null,
      readings: [
        {
          source: "ocr dni_front",
          value: normalizeDate(front.ocr.fechaVencimiento ?? ""),
        },
        {
          source: "mrz",
          value: normalizeDate(back.mrz.fechaVencimiento ?? ""),
        },
      ],
    });
    if (expiry && !isNotExpired(expiry, now)) {
      reasons.push(verificationReason("DNI_VENCIDO", { date: expiry }));
    }

    // ── CUIL (impreso solo en el dorso) ──────────────────────────────────
    this.checkCuil(reasons, matrix, profile, back.ocr.cuil, "dni_back", {
      agreedDni: dniAgreed,
      agreedSex: sexes,
    });

    // ── Domicilio (impreso solo en el dorso) ─────────────────────────────
    this.checkAddress(reasons, matrix, profile, back.ocr.domicilio, "dni_back");

    return {
      approved: reasons.length === 0,
      reasons: dedupe(reasons),
      matrix,
      documentNumber: dniAgreed,
      expiresAt: expiry,
    };
  }

  matchLicense(
    profile: IdentityProfileSnapshot,
    result: LicenseDocverifyResult,
    now = new Date(),
  ): DocumentMatchResult {
    const reasons: VerificationReason[] = [];
    const matrix: FieldMatrixRow[] = [];

    const front = result.license_front;
    const back = result.license_back;

    if (front.error) {
      reasons.push(
        verificationReason("FOTO_NO_PROCESABLE", {
          slot: "license_front",
          detail: front.error.message,
        }),
      );
    }
    if (back.error) {
      reasons.push(
        verificationReason("FOTO_NO_PROCESABLE", {
          slot: "license_back",
          detail: back.error.message,
        }),
      );
    }

    // ── Número de licencia: en la Licencia Nacional es el DNI del titular ─
    const accountDni = profile.dni ? normalizeDni(profile.dni) : null;
    const licenseNumber = front.ocr.numLicencia
      ? normalizeDni(front.ocr.numLicencia)
      : null;
    matrix.push({
      field: "numLicencia",
      readings: { cuenta: accountDni, "ocr license_front": licenseNumber },
      status: !licenseNumber
        ? "vacio"
        : licenseNumber === accountDni
          ? "ok"
          : "conflicto",
    });
    if (!licenseNumber) {
      reasons.push(
        verificationReason("CAMPO_ILEGIBLE", {
          field: "numLicencia",
          slot: "license_front",
        }),
      );
    } else if (accountDni && licenseNumber !== accountDni) {
      reasons.push(verificationReason("LICENCIA_NO_CORRESPONDE_AL_DNI"));
    }

    // ── Apellido y nombre contra la cuenta ───────────────────────────────
    this.checkName(reasons, matrix, "apellido", profile.lastName, [
      {
        source: "ocr license_front",
        value: front.ocr.apellido,
        tolerant: true,
      },
    ]);
    this.checkName(reasons, matrix, "nombre", profile.firstName, [
      { source: "ocr license_front", value: front.ocr.nombre, tolerant: true },
    ]);

    // ── Fecha de nacimiento y mayoría de edad ────────────────────────────
    const accountBirth = profile.dateOfBirth
      ? profile.dateOfBirth.toISOString().slice(0, 10)
      : null;
    const birthReadings = [
      {
        source: "ocr license_front",
        value: normalizeDate(front.ocr.fechaNacimiento ?? ""),
      },
    ];
    this.checkEqual(reasons, matrix, {
      field: "fechaNacimiento",
      slot: "license_front",
      account: accountBirth,
      readings: birthReadings,
    });
    this.checkAge(reasons, birthReadings, now);

    // ── Vencimiento de la licencia ───────────────────────────────────────
    const expiry = front.ocr.fechaVencimiento
      ? normalizeDate(front.ocr.fechaVencimiento)
      : null;
    matrix.push({
      field: "fechaVencimiento",
      readings: { "ocr license_front": expiry },
      status: expiry ? "ok" : "vacio",
    });
    if (!expiry) {
      reasons.push(
        verificationReason("CAMPO_ILEGIBLE", {
          field: "fechaVencimiento",
          slot: "license_front",
        }),
      );
    } else if (!isNotExpired(expiry, now)) {
      reasons.push(verificationReason("LICENCIA_VENCIDA", { date: expiry }));
    }

    // ── CUIL del dorso ───────────────────────────────────────────────────
    this.checkCuil(reasons, matrix, profile, back.ocr.cuil, "license_back", {
      agreedDni: accountDni,
      agreedSex: null,
    });

    // ── Período de principiante, leído del dorso ─────────────────────────
    const esPrincipiante = back.ocr.esPrincipiante;
    const finPrincipiante = back.ocr.finPrincipiante
      ? normalizeDate(back.ocr.finPrincipiante)
      : null;
    matrix.push({
      field: "esPrincipiante",
      readings: {
        "ocr license_back": esPrincipiante,
        finPrincipiante,
      },
      status:
        esPrincipiante === null
          ? "vacio"
          : esPrincipiante &&
              (!finPrincipiante || finPrincipiante > isoDate(now))
            ? "conflicto"
            : "ok",
    });
    if (esPrincipiante === null) {
      reasons.push(
        verificationReason("CAMPO_ILEGIBLE", {
          field: "esPrincipiante",
          slot: "license_back",
        }),
      );
    } else if (esPrincipiante) {
      if (!finPrincipiante) {
        reasons.push(verificationReason("PRINCIPIANTE_NO_DETERMINADO"));
      } else if (finPrincipiante > isoDate(now)) {
        // "Ya cumplida": la fecha límite tiene que haber pasado.
        reasons.push(
          verificationReason("PRINCIPIANTE_VIGENTE", { date: finPrincipiante }),
        );
      }
    }

    // ── Domicilio del frente ─────────────────────────────────────────────
    this.checkAddress(
      reasons,
      matrix,
      profile,
      front.ocr.domicilio,
      "license_front",
    );

    return {
      approved: reasons.length === 0,
      reasons: dedupe(reasons),
      matrix,
      documentNumber: licenseNumber,
      expiresAt: expiry,
    };
  }

  // ── Reglas compartidas ─────────────────────────────────────────────────

  /**
   * Nombres: la cuenta contra cada lectura del documento. `tolerant` marca
   * las fuentes ópticas (toleran un caracter mal leído por token); el resto
   * se compara exacto. "partial" (el documento trae segundos nombres) se
   * acepta: es la misma persona con el nombre completo.
   */
  private checkName(
    reasons: VerificationReason[],
    matrix: FieldMatrixRow[],
    field: "apellido" | "nombre",
    accountValue: string,
    readings: { source: string; value: string | null; tolerant: boolean }[],
  ): void {
    const row: FieldMatrixRow = {
      field,
      readings: { cuenta: accountValue },
      status: "ok",
    };
    matrix.push(row);

    let anyValue = false;
    let conflict = false;
    for (const reading of readings) {
      row.readings[reading.source] = reading.value;
      if (!reading.value) continue;
      anyValue = true;
      const compare = reading.tolerant ? compareNamesOcr : compareNames;
      if (compare(accountValue, reading.value) === "mismatch") {
        conflict = true;
      }
    }

    if (!anyValue) {
      row.status = "vacio";
      reasons.push(verificationReason("CAMPO_ILEGIBLE", { field }));
      return;
    }
    if (conflict) {
      row.status = "conflicto";
      reasons.push(
        verificationReason("CAMPO_NO_COINCIDE", {
          field,
          detail: "lo que dice el documento y los datos de tu cuenta",
        }),
      );
    }
  }

  /**
   * Mayoría de edad según el DOCUMENTO. Si las lecturas del documento
   * concuerdan entre sí y esa fecha da menos de 18 años, se informa —
   * coincida o no con lo declarado en la cuenta.
   */
  private checkAge(
    reasons: VerificationReason[],
    readings: { value: string | null }[],
    now: Date,
  ): void {
    const values = readings
      .map((reading) => reading.value)
      .filter((value): value is string => Boolean(value));
    if (values.length === 0) return;
    if (!values.every((value) => value === values[0])) return;

    if (ageOn(values[0], now) < MIN_AGE) {
      reasons.push(verificationReason("MENOR_DE_EDAD"));
    }
  }

  /**
   * Campos de igualdad estricta (número de documento, sexo, fechas): toda
   * lectura no vacía debe decir lo mismo, y si hay valor de cuenta, también.
   * Devuelve el valor acordado, o null si quedó vacío o en conflicto.
   */
  private checkEqual(
    reasons: VerificationReason[],
    matrix: FieldMatrixRow[],
    input: {
      field: string;
      slot: string;
      account: string | null;
      readings: { source: string; value: string | null }[];
    },
  ): string | null {
    const row: FieldMatrixRow = {
      field: input.field,
      readings: {},
      status: "ok",
    };
    if (input.account !== null) row.readings.cuenta = input.account;
    matrix.push(row);

    const values: string[] = [];
    for (const reading of input.readings) {
      row.readings[reading.source] = reading.value;
      if (reading.value) values.push(reading.value);
    }

    if (values.length === 0) {
      row.status = "vacio";
      reasons.push(
        verificationReason("CAMPO_ILEGIBLE", {
          field: input.field,
          slot: input.slot,
        }),
      );
      return null;
    }

    const all = input.account !== null ? [input.account, ...values] : values;
    const agreed = all.every((value) => value === all[0]);
    if (!agreed) {
      row.status = "conflicto";
      const between =
        input.account !== null && values.every((v) => v === values[0])
          ? "lo que dice el documento y los datos de tu cuenta"
          : "las distintas lecturas del documento";
      reasons.push(
        verificationReason("CAMPO_NO_COINCIDE", {
          field: input.field,
          detail: between,
        }),
      );
      return null;
    }

    return all[0];
  }

  /**
   * CUIL: debe leerse del documento, coincidir con la cuenta, tener dígito
   * verificador válido, contener el número de documento y (cuando el
   * prefijo lo determina) el sexo del documento.
   */
  private checkCuil(
    reasons: VerificationReason[],
    matrix: FieldMatrixRow[],
    profile: IdentityProfileSnapshot,
    documentCuil: string | null,
    slot: string,
    context: { agreedDni: string | null; agreedSex: string | null },
  ): void {
    const accountCuil = profile.cuil ? normalizeCuil(profile.cuil) : null;
    const readCuil = documentCuil ? normalizeCuil(documentCuil) : null;

    const row: FieldMatrixRow = {
      field: "cuil",
      readings: { cuenta: accountCuil, [`ocr ${slot}`]: readCuil },
      status: "ok",
    };
    matrix.push(row);

    if (!readCuil) {
      row.status = "vacio";
      reasons.push(
        verificationReason("CAMPO_ILEGIBLE", { field: "cuil", slot }),
      );
      return;
    }
    if (!cuilChecksumValid(readCuil)) {
      row.status = "conflicto";
      reasons.push(
        verificationReason("CAMPO_ILEGIBLE", { field: "cuil", slot }),
      );
      return;
    }
    if (accountCuil && readCuil !== accountCuil) {
      row.status = "conflicto";
      reasons.push(
        verificationReason("CAMPO_NO_COINCIDE", {
          field: "cuil",
          detail: "el impreso en el documento y el cargado en tu cuenta",
        }),
      );
      return;
    }
    if (context.agreedDni && !dniMatchesCuil(context.agreedDni, readCuil)) {
      row.status = "conflicto";
      reasons.push(verificationReason("CUIL_NO_CORRESPONDE_AL_DNI"));
      return;
    }
    const prefixSex = cuilPrefixSex(readCuil);
    if (prefixSex && context.agreedSex && prefixSex !== context.agreedSex) {
      row.status = "conflicto";
      reasons.push(
        verificationReason("CAMPO_NO_COINCIDE", {
          field: "sexo",
          detail: "el prefijo del CUIL y el sexo del documento",
        }),
      );
    }
  }

  /** Domicilio: similitud, con mensajes más suaves que el resto. */
  private checkAddress(
    reasons: VerificationReason[],
    matrix: FieldMatrixRow[],
    profile: IdentityProfileSnapshot,
    documentAddress: string | null,
    slot: string,
  ): void {
    const row: FieldMatrixRow = {
      field: "domicilio",
      readings: {
        cuenta: profile.address,
        [`ocr ${slot}`]: documentAddress,
      },
      status: "ok",
    };
    matrix.push(row);

    if (!documentAddress) {
      row.status = "vacio";
      reasons.push(verificationReason("DOMICILIO_ILEGIBLE"));
      return;
    }
    if (!profile.address) return;

    const similarity = addressSimilarity(profile.address, documentAddress);
    if (similarity < ADDRESS_MIN_SIMILARITY) {
      row.status = "advertencia";
      reasons.push(verificationReason("DOMICILIO_NO_COINCIDE"));
    }
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Un motivo por código+campo: el mismo problema no se repite en la lista. */
function dedupe(reasons: VerificationReason[]): VerificationReason[] {
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = `${reason.code}:${reason.field ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
