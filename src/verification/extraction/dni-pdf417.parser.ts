import {
  ParseResult,
  parseFail,
  parseOk,
  sample,
  verificationError,
} from "../errors/verification-errors";
import {
  normalizeDate,
  normalizeDni,
  normalizeSex,
} from "../matching/normalize.util";

/**
 * Datos del PDF417 del DNI argentino (tarjeta 2012+). Es la fuente
 * AUTORITATIVA de apellido, nombre, sexo, número y fecha de nacimiento: no la
 * transcribe un modelo, la lee un decodificador determinístico del código
 * impreso por el RENAPER.
 *
 * Formato (separado por @):
 *   nroTramite@APELLIDO@NOMBRE@SEXO@DNI@EJEMPLAR@DD/MM/AAAA nac@DD/MM/AAAA emisión
 * Hay variantes que agregan campos al final (CUIL, oficina, etc.), así que el
 * parser tolera longitudes mayores y solo exige los ocho primeros.
 *
 * Nota: el PDF417 NO contiene domicilio ni CUIL — esos se cruzan por OCR.
 */
export interface DniBarcodeData {
  procedureNumber: string;
  lastName: string;
  firstName: string;
  sex: "M" | "F" | null;
  dni: string;
  copy: string;
  birthDate: string;
  issueDate: string | null;
}

const MIN_FIELDS = 8;

/**
 * Interpreta el payload diciendo POR QUÉ no se pudo, cuando no se puede.
 *
 * La versión que devuelve `null` sigue existiendo abajo para todos los que ya
 * la usan, pero `null` no distingue "esto no es un PDF417 del RENAPER" de
 * "sí lo es y se leyó a medias", que es justo lo que hay que saber para
 * arreglar una foto.
 */
export function tryParseDniPdf417(
  payload: string,
): ParseResult<DniBarcodeData> {
  const trimmed = payload.trim();
  const fields = trimmed.split("@");

  if (fields.length < 2) {
    return parseFail(
      verificationError("DNI_PDF417_MALFORMED", {
        sample: sample(trimmed, 40),
      }),
    );
  }
  if (fields.length < MIN_FIELDS) {
    return parseFail(
      verificationError("DNI_PDF417_INCOMPLETE", {
        fieldCount: fields.length,
        expected: MIN_FIELDS,
        sample: sample(trimmed, 40),
      }),
    );
  }

  const [procedureNumber, lastName, firstName, sex, dni, copy, birth, issue] =
    fields;

  // Sin número de documento ni fecha de nacimiento no sirve como ancla.
  const normalizedDni = normalizeDni(dni ?? "");
  if (!normalizedDni) {
    return parseFail(
      verificationError("DNI_PDF417_NO_NUMBER", { got: sample(dni ?? "", 20) }),
    );
  }

  const birthDate = normalizeDate(birth ?? "");
  if (!birthDate) {
    return parseFail(
      verificationError("DNI_PDF417_NO_BIRTHDATE", {
        got: sample(birth ?? "", 20),
      }),
    );
  }

  if (!lastName?.trim() || !firstName?.trim()) {
    return parseFail(verificationError("DNI_PDF417_NO_NAMES"));
  }

  return parseOk({
    procedureNumber: procedureNumber.trim(),
    lastName: lastName.trim(),
    firstName: firstName.trim(),
    sex: normalizeSex(sex ?? ""),
    dni: normalizedDni,
    copy: (copy ?? "").trim(),
    birthDate,
    issueDate: normalizeDate(issue ?? ""),
  });
}

/** Igual que tryParseDniPdf417 pero sin el motivo. Se usa como predicado. */
export function parseDniPdf417(payload: string): DniBarcodeData | null {
  const result = tryParseDniPdf417(payload);
  return result.ok ? result.data : null;
}
