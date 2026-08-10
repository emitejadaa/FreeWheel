/**
 * Normalización previa a cualquier comparación entre documentos, códigos y
 * datos de la cuenta. Los mismos datos vienen escritos de formas distintas en
 * cada fuente (tildes, mayúsculas, puntos en el DNI, fechas DD/MM/AAAA vs
 * AAMMDD del MRZ), así que todo se lleva a una forma canónica antes de
 * comparar. Sin estado ni IO: 100% testeable.
 */

/** Mayúsculas sin tildes/diacríticos y con espacios colapsados. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // diacriticos combinantes
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokens alfanuméricos de un texto normalizado. */
export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/** DNI sin puntos ni espacios; null si no quedan 7-8 dígitos. */
export function normalizeDni(value: string): string | null {
  const digits = value.replace(/\D/g, "").replace(/^0+/, "");
  return /^\d{7,8}$/.test(digits) ? digits : null;
}

/** "M"/"F" desde M, F, MASCULINO, FEMENINO, etc. null si no es reconocible. */
export function normalizeSex(value: string): "M" | "F" | null {
  const normalized = normalizeText(value);
  if (normalized.startsWith("M")) return "M";
  if (normalized.startsWith("F")) return "F";
  return null;
}

/**
 * Fecha a ISO `YYYY-MM-DD`. Acepta DD/MM/YYYY (impreso y PDF417), YYYY-MM-DD
 * (cuenta) y YYMMDD (MRZ). Valida que la fecha exista de verdad (31/02 → null).
 */
export function normalizeDate(value: string): string | null {
  const trimmed = value.trim();

  let year: number;
  let month: number;
  let day: number;

  const slashed = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const mrz = /^(\d{2})(\d{2})(\d{2})$/.exec(trimmed);

  if (slashed) {
    day = Number(slashed[1]);
    month = Number(slashed[2]);
    year = Number(slashed[3]);
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (mrz) {
    // Ventana ICAO: 2 dígitos. Un año > actual+20 se interpreta como 19xx
    // (nacimientos), el resto como 20xx (vencimientos).
    const twoDigit = Number(mrz[1]);
    const currentTwoDigit = new Date().getUTCFullYear() % 100;
    year = twoDigit > currentTwoDigit + 20 ? 1900 + twoDigit : 2000 + twoDigit;
    month = Number(mrz[2]);
    day = Number(mrz[3]);
  } else {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

/** Fecha ISO (YYYY-MM-DD) → Date en UTC. */
export function isoToDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Edad cumplida en UTC a la fecha de referencia. */
export function ageOn(birthIso: string, reference = new Date()): number {
  const birth = isoToDate(birthIso);
  let age = reference.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = reference.getUTCMonth() - birth.getUTCMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && reference.getUTCDate() < birth.getUTCDate())
  ) {
    age -= 1;
  }
  return age;
}

/** true si la fecha de vencimiento es hoy o futura (documento vigente). */
export function isNotExpired(
  expiryIso: string,
  reference = new Date(),
): boolean {
  const today = reference.toISOString().slice(0, 10);
  return expiryIso >= today;
}

/**
 * Comparación de nombres tolerante al orden y a nombres de pila extra: los
 * tokens de la cuenta deben estar todos en el documento. "JUAN" contra
 * "JUAN CARLOS" da "partial"; "JUAN CARLOS" contra "JUAN" también (el
 * documento manda), pero "PEDRO" contra "JUAN" da "mismatch".
 */
export function compareNames(
  accountValue: string,
  documentValue: string,
): "match" | "partial" | "mismatch" {
  const accountTokens = tokenize(accountValue);
  const documentTokens = tokenize(documentValue);

  if (accountTokens.length === 0 || documentTokens.length === 0) {
    return "mismatch";
  }
  if (accountTokens.join(" ") === documentTokens.join(" ")) return "match";

  const shared = accountTokens.filter((token) =>
    documentTokens.includes(token),
  );

  // El primer nombre/apellido de la cuenta tiene que aparecer en el documento:
  // es el que identifica a la persona.
  if (!shared.includes(accountTokens[0])) return "mismatch";

  return "partial";
}

/**
 * Similitud de domicilios: proporción de tokens de la cuenta presentes en el
 * documento, ignorando abreviaturas y palabras vacías frecuentes. Los
 * formatos varían mucho ("Av. Siempre Viva 742" vs "AV SIEMPRE VIVA 742 CABA"),
 * por eso es un puntaje y no una igualdad.
 */
const ADDRESS_STOPWORDS = new Set([
  "AV",
  "AVDA",
  "AVENIDA",
  "CALLE",
  "PISO",
  "DPTO",
  "DEPTO",
  "DEPARTAMENTO",
  "N",
  "NRO",
  "NUMERO",
  "BIS",
  "DE",
  "DEL",
  "LA",
  "LAS",
  "LOS",
  "EL",
]);

export function addressSimilarity(a: string, b: string): number {
  const significant = (value: string) =>
    tokenize(value).filter((token) => !ADDRESS_STOPWORDS.has(token));

  const left = significant(a);
  const right = new Set(significant(b));
  if (left.length === 0 || right.size === 0) return 0;

  const shared = left.filter((token) => right.has(token)).length;
  return shared / left.length;
}
