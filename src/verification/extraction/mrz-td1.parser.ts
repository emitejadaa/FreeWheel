import {
  normalizeDate,
  normalizeDni,
  normalizeSex,
} from "../matching/normalize.util";

/**
 * MRZ TD1 (ICAO 9303) del dorso del DNI: 3 líneas de 30 caracteres con
 * dígitos verificadores propios. Como las líneas las transcribe un modelo de
 * visión (no un decodificador), los check digits son la red de seguridad: si
 * cierran, el dato es confiable y sirve como ancla autoritativa; si no
 * cierran, lo más probable es una mala transcripción, así que se trata como
 * fuente NO disponible (nunca como fraude).
 *
 * Se implementa a mano (el paquete npm `mrz` es ESM-only y no convive con el
 * build CJS del proyecto). Algoritmo: pesos cíclicos 7-3-1, '0'-'9' valen su
 * dígito, 'A'-'Z' valen 10..35, '<' vale 0, y el verificador es la suma mod 10.
 */
export interface MrzData {
  documentNumber: string;
  lastName: string;
  firstName: string;
  sex: "M" | "F" | null;
  birthDate: string;
  expiryDate: string;
  nationality: string;
  /** true solo si TODOS los dígitos verificadores cierran. */
  checksumValid: boolean;
}

const WEIGHTS = [7, 3, 1];

export function mrzCharValue(char: string): number {
  if (char === "<") return 0;
  if (char >= "0" && char <= "9") return char.charCodeAt(0) - 48;
  if (char >= "A" && char <= "Z") return char.charCodeAt(0) - 55;
  return -1;
}

/** Dígito verificador de un campo MRZ, o null si trae caracteres inválidos. */
export function mrzCheckDigit(value: string): number | null {
  let sum = 0;
  for (let index = 0; index < value.length; index += 1) {
    const charValue = mrzCharValue(value[index]);
    if (charValue < 0) return null;
    sum += charValue * WEIGHTS[index % WEIGHTS.length];
  }
  return sum % 10;
}

function checkField(value: string, expected: string): boolean {
  const digit = mrzCheckDigit(value);
  return digit !== null && String(digit) === expected;
}

/** Normaliza las tres líneas: mayúsculas, sin espacios, exactamente 30 chars. */
function normalizeLines(lines: string[]): string[] | null {
  const cleaned = lines
    .map((line) => line.toUpperCase().replace(/\s+/g, ""))
    .filter((line) => line.length > 0);

  if (cleaned.length !== 3) return null;
  if (cleaned.some((line) => line.length !== 30)) return null;
  return cleaned;
}

export function parseMrzTd1(lines: string[]): MrzData | null {
  const normalized = normalizeLines(lines);
  if (!normalized) return null;

  const [line1, line2, line3] = normalized;

  // Línea 1: I<ARG + documentNumber(9) + check(1) + opcionales(15)
  const rawDocumentNumber = line1.slice(5, 14);
  const documentCheck = line1.charAt(14);

  // Línea 2: nacimiento(6)+check(1) + sexo(1) + vencimiento(6)+check(1) +
  //          nacionalidad(3) + opcionales(11) + check compuesto(1)
  const rawBirth = line2.slice(0, 6);
  const birthCheck = line2.charAt(6);
  const sex = line2.charAt(7);
  const rawExpiry = line2.slice(8, 14);
  const expiryCheck = line2.charAt(14);
  const nationality = line2.slice(15, 18).replace(/</g, "");
  const compositeCheck = line2.charAt(29);

  // Línea 3: APELLIDO<<NOMBRES separados por <
  const [lastNameRaw = "", firstNameRaw = ""] = line3.split("<<");

  const birthDate = normalizeDate(rawBirth);
  const expiryDate = normalizeDate(rawExpiry);
  const documentNumber = normalizeDni(rawDocumentNumber.replace(/</g, ""));
  if (!birthDate || !expiryDate || !documentNumber) return null;

  // El check compuesto cubre documento+checks+fechas+opcionales (ICAO 9303).
  const compositeBase =
    line1.slice(5, 30) +
    line2.slice(0, 7) +
    line2.slice(8, 15) +
    line2.slice(18, 29);

  const checksumValid =
    checkField(rawDocumentNumber, documentCheck) &&
    checkField(rawBirth, birthCheck) &&
    checkField(rawExpiry, expiryCheck) &&
    checkField(compositeBase, compositeCheck);

  return {
    documentNumber,
    lastName: lastNameRaw.replace(/</g, " ").trim(),
    firstName: firstNameRaw.replace(/</g, " ").trim(),
    sex: normalizeSex(sex),
    birthDate,
    expiryDate,
    nationality,
    checksumValid,
  };
}
