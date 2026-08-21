import {
  ParseResult,
  parseOk,
  sample,
  verificationError,
} from "../errors/verification-errors";
import { normalizeDate, normalizeDni } from "../matching/normalize.util";

/**
 * Código del dorso de la Licencia Nacional de Conducir (QR, a veces PDF417).
 * El payload NO está estandarizado entre jurisdicciones ni épocas: puede ser
 * JSON, pares clave=valor, campos separados por @ o | , o simplemente una URL
 * opaca de validación. Por eso el parseo es best-effort e INFORMATIVO: lo que
 * se logre leer suma como corroboración, pero que no se pueda leer nunca
 * bloquea ni rechaza una verificación (la pata licencia se sostiene con el
 * OCR del frente cruzado contra el DNI, que sí es determinístico).
 */
export interface LicenseCodeData {
  dni: string | null;
  expiryDate: string | null;
  /** false cuando el payload es opaco (una URL o un id sin datos legibles). */
  parsed: boolean;
}

const DNI_KEYS = ["dni", "documento", "nrodoc", "nrodocumento", "doc"];
const EXPIRY_KEYS = ["vencimiento", "vto", "expira", "expiry", "fechavto"];

function fromKeyValuePairs(payload: string): Partial<LicenseCodeData> {
  const result: Partial<LicenseCodeData> = {};
  // Un QR suele traer pares sueltos o una URL con query string: se parten por
  // los separadores habituales y también por "?" para alcanzar la query.
  const pairs = payload.split(/[;&|?\n]/);

  for (const pair of pairs) {
    const separator = pair.search(/[=:]/);
    if (separator <= 0) continue;

    const key = pair
      .slice(0, separator)
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    const value = pair.slice(separator + 1).trim();
    if (value.length === 0) continue;

    if (DNI_KEYS.includes(key)) result.dni = normalizeDni(value);
    if (EXPIRY_KEYS.includes(key)) result.expiryDate = normalizeDate(value);
  }

  return result;
}

function fromJson(payload: string): Partial<LicenseCodeData> | null {
  if (!payload.trim().startsWith("{")) return null;
  try {
    const data = JSON.parse(payload) as Record<string, unknown>;
    const result: Partial<LicenseCodeData> = {};

    for (const [rawKey, rawValue] of Object.entries(data)) {
      if (typeof rawValue !== "string" && typeof rawValue !== "number")
        continue;
      const key = rawKey.toLowerCase().replace(/[^a-z]/g, "");
      const value = String(rawValue);
      if (DNI_KEYS.includes(key)) result.dni = normalizeDni(value);
      if (EXPIRY_KEYS.includes(key)) result.expiryDate = normalizeDate(value);
    }

    return result;
  } catch {
    return null;
  }
}

/** Payloads delimitados por @ (mismo estilo que el PDF417 del DNI). */
function fromDelimited(payload: string): Partial<LicenseCodeData> {
  const fields = payload.split("@");
  if (fields.length < 2) return {};

  const result: Partial<LicenseCodeData> = {};
  for (const field of fields) {
    const value = field.trim();
    if (!result.dni) {
      const dni = /^\d{7,8}$/.test(value) ? normalizeDni(value) : null;
      if (dni) result.dni = dni;
    }
    if (!result.expiryDate && /^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(value)) {
      result.expiryDate = normalizeDate(value);
    }
  }
  return result;
}

/**
 * Interpreta el código de la licencia. NUNCA falla: un payload opaco es un
 * resultado válido —la mayoría de las jurisdicciones imprimen solo un link de
 * validación— y sale como advertencia, no como error. Lo que importa acá es
 * que el payload crudo quede a la vista para poder reconocer el formato de
 * cada provincia a medida que aparecen.
 */
export function tryParseLicenseCode(
  payload: string,
): ParseResult<LicenseCodeData> {
  const trimmed = payload.trim();
  if (trimmed.length === 0) {
    return parseOk({ dni: null, expiryDate: null, parsed: false }, [
      verificationError("LICENSE_CODE_OPAQUE", { sample: "(vacío)" }),
    ]);
  }

  const extracted =
    fromJson(trimmed) ??
    (trimmed.includes("=") || trimmed.includes(":")
      ? fromKeyValuePairs(trimmed)
      : fromDelimited(trimmed));

  const dni = extracted.dni ?? null;
  const expiryDate = extracted.expiryDate ?? null;
  const parsed = dni !== null || expiryDate !== null;

  return parseOk(
    { dni, expiryDate, parsed },
    parsed
      ? []
      : [
          verificationError("LICENSE_CODE_OPAQUE", {
            sample: sample(trimmed, 80),
          }),
        ],
  );
}

export function parseLicenseCode(payload: string): LicenseCodeData {
  const result = tryParseLicenseCode(payload);
  return result.ok
    ? result.data
    : { dni: null, expiryDate: null, parsed: false };
}
