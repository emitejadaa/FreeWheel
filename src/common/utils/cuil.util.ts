/**
 * Validación matemática del CUIL/CUIT argentino: XY-DDDDDDDD-Z donde XY es el
 * prefijo, DDDDDDDD el DNI (con ceros a la izquierda) y Z el dígito
 * verificador mod-11. Permite validar el CUIL cargado por el usuario y
 * cruzarlo contra el DNI y el sexo del documento aunque no esté impreso.
 */

const CUIL_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Prefijos asignados a personas físicas (30/33/34 son sociedades). */
export const PERSON_CUIL_PREFIXES = ["20", "23", "24", "25", "26", "27"];

/** Quita guiones/espacios; devuelve los 11 dígitos o null si no es un CUIL. */
export function normalizeCuil(value: string): string | null {
  const digits = value.replace(/[-\s]/g, "");
  return /^\d{11}$/.test(digits) ? digits : null;
}

/**
 * Dígito verificador mod-11 sobre los primeros 10 dígitos. Un resto que
 * exige dígito 10 no existe como CUIL real (en la asignación se cambia el
 * prefijo a 23), así que se rechaza.
 */
export function cuilChecksumValid(cuil: string): boolean {
  if (!/^\d{11}$/.test(cuil)) return false;

  const sum = CUIL_WEIGHTS.reduce(
    (acc, weight, index) => acc + weight * Number(cuil[index]),
    0,
  );
  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? 0 : remainder;

  return expected !== 10 && Number(cuil[10]) === expected;
}

export function cuilPrefix(cuil: string): string {
  return cuil.slice(0, 2);
}

/** DNI embebido en el CUIL, siempre 8 dígitos (DNIs de 7 vienen con 0 inicial). */
export function cuilEmbeddedDni(cuil: string): string {
  return cuil.slice(2, 10);
}

export function dniMatchesCuil(dni: string, cuil: string): boolean {
  return cuilEmbeddedDni(cuil) === dni.padStart(8, "0");
}

/**
 * Sexo que fija el prefijo: 20 = M, 27 = F. Los prefijos 23/24/25/26 se
 * asignan ante colisiones y no determinan sexo (null = no concluyente).
 */
export function cuilPrefixSex(cuil: string): "M" | "F" | null {
  const prefix = cuilPrefix(cuil);
  if (prefix === "20") return "M";
  if (prefix === "27") return "F";
  return null;
}

/** CUIL de persona física completo: 11 dígitos, prefijo de persona y checksum. */
export function isValidPersonCuil(value: string): boolean {
  const normalized = normalizeCuil(value);
  return (
    normalized !== null &&
    PERSON_CUIL_PREFIXES.includes(cuilPrefix(normalized)) &&
    cuilChecksumValid(normalized)
  );
}
