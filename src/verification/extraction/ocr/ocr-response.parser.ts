import {
  findJsonObject,
  stripReasoning,
} from "../../../common/utils/json-from-text.util";
import { normalizeCuil } from "../../../common/utils/cuil.util";
import {
  ParseResult,
  VerificationError,
  parseFail,
  parseOk,
  sample,
  verificationError,
} from "../../errors/verification-errors";
import {
  normalizeDate,
  normalizeDni,
  normalizeSex,
  normalizeText,
} from "../../matching/normalize.util";
import { DocumentSlot, OcrExtraction, OcrFields } from "../extraction.types";
import { MAX_RAW_TEXT } from "./ocr-prompt";
import {
  CanonicalField,
  OcrBox,
  OcrDocumentRead,
  OcrFieldValue,
  SLOT_VOCABULARY,
} from "./ocr.types";

/**
 * Cómo se llama cada dato en cada dialecto que puede contestar el modelo.
 *
 * La clave está normalizada (minúsculas, sin acentos ni separadores), así que
 * "nro_documento", "nroDocumento" y "número de documento" caen todas en la
 * misma entrada. Incluye a propósito los nombres del formato ANTERIOR: si el
 * modelo se cae a ese formato —o si se está leyendo una respuesta guardada de
 * antes— el dato se sigue entendiendo en vez de perderse en silencio.
 */
const FIELD_ALIASES: Record<string, CanonicalField> = {
  apellido: "lastName",
  apellidos: "lastName",
  surname: "lastName",
  nombre: "firstName",
  nombres: "firstName",
  name: "firstName",
  givennames: "firstName",
  sexo: "sex",
  sex: "sex",
  nrodocumento: "documentNumber",
  numerodocumento: "documentNumber",
  documento: "documentNumber",
  dni: "documentNumber",
  documentnumber: "documentNumber",
  fechanacimiento: "birthDate",
  fechadenacimiento: "birthDate",
  nacimiento: "birthDate",
  birthdate: "birthDate",
  fechaemision: "issueDate",
  fechadeemision: "issueDate",
  emision: "issueDate",
  issuedate: "issueDate",
  fechavencimiento: "expiryDate",
  fechadevencimiento: "expiryDate",
  vencimiento: "expiryDate",
  expirydate: "expiryDate",
  domicilio: "address",
  direccion: "address",
  address: "address",
  cuil: "cuil",
  cuit: "cuil",
  nrotramite: "procedureNumber",
  numerotramite: "procedureNumber",
  tramite: "procedureNumber",
  ejemplar: "copy",
  copy: "copy",
  clase: "licenseClass",
  clases: "licenseClass",
  categoria: "licenseClass",
  nrolicencia: "licenseNumber",
  numerolicencia: "licenseNumber",
  licencia: "licenseNumber",
};

/** Cómo se dice cada slot, en todas las formas que se vieron o se esperan. */
const CLASSIFICATION_ALIASES: Record<string, DocumentSlot> = {
  dnifrente: "dni_front",
  dnifront: "dni_front",
  frentedni: "dni_front",
  frentedeldni: "dni_front",
  anversodni: "dni_front",
  anversodeldni: "dni_front",
  dnianverso: "dni_front",
  dnidorso: "dni_back",
  dniback: "dni_back",
  dorsodni: "dni_back",
  dorsodeldni: "dni_back",
  reversodni: "dni_back",
  reversodeldni: "dni_back",
  licenciafrente: "license_front",
  licensefront: "license_front",
  frentelicencia: "license_front",
  frentedelalicencia: "license_front",
  licenciadeconducirfrente: "license_front",
  licenciadorso: "license_back",
  licenseback: "license_back",
  dorsolicencia: "license_back",
  dorsodelalicencia: "license_back",
  licenciadeconducirdorso: "license_back",
};

/** Cuando el modelo dice el documento pero no el lado. */
const DOCUMENT_ONLY: Record<string, "dni" | "license"> = {
  dni: "dni",
  documentonacionaldeidentidad: "dni",
  idcard: "dni",
  licencia: "license",
  licenciadeconducir: "license",
  license: "license",
  driverlicense: "license",
  carnet: "license",
  registro: "license",
};

/** Normaliza una clave o un valor para poder buscarlo en las tablas de arriba. */
function key(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Cada campo se normaliza según lo que es; el texto crudo se conserva igual. */
function normalizeValue(field: CanonicalField, raw: string): string | null {
  switch (field) {
    case "documentNumber":
    case "licenseNumber":
      return normalizeDni(raw);
    case "birthDate":
    case "issueDate":
    case "expiryDate":
      return normalizeDate(raw);
    case "sex":
      return normalizeSex(raw);
    case "cuil":
      return normalizeCuil(raw);
    default: {
      const limpio = normalizeText(raw);
      return limpio.length > 0 ? limpio : null;
    }
  }
}

/** Qué se espera de cada campo, para poder decirlo cuando no se cumple. */
const EXPECTED: Partial<Record<CanonicalField, string>> = {
  documentNumber: "un número de documento de 7 u 8 dígitos",
  licenseNumber: "un número de 7 u 8 dígitos",
  birthDate: "una fecha",
  issueDate: "una fecha",
  expiryDate: "una fecha",
  sex: "M o F",
  cuil: "un CUIL de 11 dígitos",
};

function asText(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const limpio = value.trim();
  if (limpio.length === 0) return null;
  // Un modelo que no leyó un campo a veces contesta la palabra, no lo omite.
  if (["null", "undefined", "n/a", "-"].includes(limpio.toLowerCase())) {
    return null;
  }
  return limpio;
}

function readBox(
  value: unknown,
  field: string,
): { box?: OcrBox; warning?: VerificationError } {
  if (value === undefined || value === null) return {};

  const nums = Array.isArray(value)
    ? value.filter((n): n is number => typeof n === "number")
    : [];
  const dentroDeRango = nums.every((n) => n >= 0 && n <= 1000);

  if (nums.length !== 4 || !dentroDeRango || nums[2] <= 0 || nums[3] <= 0) {
    return {
      warning: verificationError("OCR_BOX_INVALID", {
        field,
        got: JSON.stringify(value).slice(0, 40),
      }),
    };
  }

  const [x, y, w, h] = nums;
  return { box: { x, y, w, h } };
}

interface RawField {
  valor: unknown;
  etiqueta?: unknown;
  caja?: unknown;
  legible?: unknown;
}

/** Un campo puede venir como objeto con evidencia o como un string pelado. */
function readFieldEntry(entry: unknown): RawField | null {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === "string" || typeof entry === "number") {
    return { valor: entry };
  }
  if (typeof entry !== "object") return null;

  const record = entry as Record<string, unknown>;
  // "valor" es lo pedido; los otros nombres son por si el modelo se desvía.
  const valor = record.valor ?? record.value ?? record.text ?? record.texto;
  if (valor === undefined) return null;

  return {
    valor,
    etiqueta: record.etiqueta ?? record.label ?? record.rotulo,
    caja: record.caja ?? record.box ?? record.bbox,
    legible: record.legible ?? record.readable,
  };
}

/** Las tres líneas del MRZ, vengan donde vengan. */
function readMrz(record: Record<string, unknown>): string[] {
  const candidatos = [record.mrz, record.mrzLines, record.mrz_lineas];
  for (const candidato of candidatos) {
    if (Array.isArray(candidato)) {
      const lineas = candidato
        .map((linea) => asText(linea))
        .filter((linea): linea is string => linea !== null);
      if (lineas.length > 0) return lineas;
    }
  }

  // También puede venir línea por línea: mrz_linea_1, mrz_linea_2, ...
  const sueltas = [1, 2, 3]
    .map((n) => asText(record[`mrz_linea_${n}`] ?? record[`mrzLinea${n}`]))
    .filter((linea): linea is string => linea !== null);
  return sueltas;
}

/**
 * Qué documento dice el modelo que es la foto.
 *
 * Si nombra el documento pero no el lado ("DNI" a secas), no se lo puede tomar
 * como una contradicción: se interpreta como el lado que se esperaba si es del
 * mismo documento, y como el otro documento si no. Tomar "DNI" por "no sé qué
 * es esto" mandaba a revisión manual verificaciones perfectas.
 */
export function normalizeClassification(
  value: unknown,
  expected: DocumentSlot,
): {
  slot: DocumentSlot | "unknown";
  raw: string | null;
  warning?: VerificationError;
} {
  const raw = asText(value);
  if (!raw) return { slot: "unknown", raw: null };

  const normalizado = key(raw);

  // El nombre exacto del slot es el camino feliz.
  if (
    ["dni_front", "dni_back", "license_front", "license_back"].includes(
      raw.trim().toLowerCase(),
    )
  ) {
    return { slot: raw.trim().toLowerCase() as DocumentSlot, raw };
  }

  const porAlias = CLASSIFICATION_ALIASES[normalizado];
  if (porAlias) {
    return {
      slot: porAlias,
      raw,
      ...(porAlias === expected
        ? {}
        : {
            warning: verificationError("OCR_CLASSIFICATION_ALIASED", {
              got: raw,
              expected: porAlias,
            }),
          }),
    };
  }

  const documento = DOCUMENT_ONLY[normalizado];
  if (documento) {
    const esperadoEsDelMismo = expected.startsWith(
      documento === "dni" ? "dni" : "license",
    );
    const slot = esperadoEsDelMismo
      ? expected
      : documento === "dni"
        ? "dni_front"
        : "license_front";
    return {
      slot,
      raw,
      warning: verificationError("OCR_CLASSIFICATION_ALIASED", {
        got: raw,
        expected: slot,
      }),
    };
  }

  return { slot: "unknown", raw };
}

/**
 * MÓDULO 1 · interpreta lo que contestó el modelo. Puro: sin red, sin Nest.
 *
 * Acá está todo lo que puede salir mal con una respuesta de un modelo, y cada
 * cosa sale con su motivo: un JSON que no parsea, un campo que no estaba en lo
 * que se pidió, una fecha que no es una fecha, una posición imposible. El
 * criterio es no perder NADA en silencio: lo que no se puede usar se descarta,
 * pero queda anotado con el porqué.
 */
export function parseOcrResponse(
  slot: DocumentSlot,
  raw: string,
  meta: { model?: string | null; durationMs?: number } = {},
): ParseResult<OcrDocumentRead> {
  const limpio = stripReasoning(raw ?? "");
  const candidato = findJsonObject(limpio);

  if (!candidato) {
    return parseFail(
      verificationError("OCR_RESPONSE_NOT_JSON", {
        slot,
        sample: sample(limpio || raw || "", 120),
      }),
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(candidato);
  } catch (error) {
    return parseFail(
      verificationError(
        "OCR_RESPONSE_MALFORMED",
        {
          slot,
          cause: error instanceof Error ? error.message : String(error),
        },
        sample(candidato, 200),
      ),
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return parseFail(
      verificationError("OCR_RESPONSE_MALFORMED", {
        slot,
        cause: "se esperaba un objeto y llegó otra cosa",
      }),
    );
  }

  const record = data as Record<string, unknown>;
  const warnings: VerificationError[] = [];

  const clasificacion = normalizeClassification(
    record.documento ?? record.classifiedAs ?? record.document,
    slot,
  );
  if (clasificacion.warning) warnings.push(clasificacion.warning);

  const { fields, mrzFromFields } = readFields(record, slot, warnings);
  const mrz = readMrz(record);
  const mrzLines = mrz.length > 0 ? mrz : mrzFromFields;

  const textoCompleto = asText(
    record.texto_completo ?? record.rawText ?? record.textoCompleto,
  );
  let rawText = textoCompleto;
  if (textoCompleto && textoCompleto.length > MAX_RAW_TEXT) {
    warnings.push(
      verificationError("OCR_TEXT_TRUNCATED", {
        limit: MAX_RAW_TEXT,
        got: textoCompleto.length,
      }),
    );
    rawText = textoCompleto.slice(0, MAX_RAW_TEXT);
  }

  if (Object.keys(fields).length === 0 && mrzLines.length === 0) {
    warnings.push(verificationError("OCR_NO_FIELDS", { slot }));
  }
  if (clasificacion.slot === "unknown") {
    warnings.push(verificationError("OCR_DOCUMENT_UNRECOGNIZED", { slot }));
  }

  return parseOk({
    slot,
    classifiedAs: clasificacion.slot,
    classifiedAsRaw: clasificacion.raw,
    fields,
    mrzLines,
    rawText,
    observations: asText(record.observaciones ?? record.observations),
    warnings,
    model: meta.model ?? null,
    durationMs: meta.durationMs ?? 0,
  });
}

/** Lee `campos` en cualquiera de las formas en que puede venir. */
function readFields(
  record: Record<string, unknown>,
  slot: DocumentSlot,
  warnings: VerificationError[],
): {
  fields: Partial<Record<CanonicalField, OcrFieldValue>>;
  mrzFromFields: string[];
} {
  const permitidos = new Set<CanonicalField>(SLOT_VOCABULARY[slot]);
  const fields: Partial<Record<CanonicalField, OcrFieldValue>> = {};
  const mrzFromFields: string[] = [];

  const contenedor = record.campos ?? record.fields;
  const entradas: [string, unknown][] = [];

  // `fields` (en vez de `campos`) es el nombre que usaba el formato anterior:
  // se lee igual, pero queda anotado para poder ver si el modelo dejó de
  // respetar el formato que se le pide hoy.
  if (record.campos === undefined && record.fields !== undefined) {
    warnings.push(verificationError("OCR_LEGACY_SHAPE"));
  }

  if (Array.isArray(contenedor)) {
    // El modelo devolvió una lista [{campo, valor}, ...] en vez del objeto.
    for (const item of contenedor) {
      if (!item || typeof item !== "object") continue;
      const fila = item as Record<string, unknown>;
      const nombre = asText(fila.campo ?? fila.field ?? fila.nombre_campo);
      if (nombre) entradas.push([nombre, fila]);
    }
  } else if (contenedor && typeof contenedor === "object") {
    entradas.push(...Object.entries(contenedor as Record<string, unknown>));
  } else {
    // Forma plana del formato anterior: las claves cuelgan de la raíz.
    const planas = Object.entries(record).filter(
      ([nombre]) => FIELD_ALIASES[key(nombre)] !== undefined,
    );
    if (planas.length > 0) {
      warnings.push(verificationError("OCR_LEGACY_SHAPE"));
      entradas.push(...planas);
    }
  }

  for (const [nombre, valorCrudo] of entradas) {
    const normalizado = key(nombre);

    // Las líneas del MRZ no son un campo: son un array aparte. Pueden venir
    // como las tres juntas o como una clave por línea.
    if (normalizado.startsWith("mrz")) {
      const valor = readFieldEntry(valorCrudo)?.valor ?? valorCrudo;
      if (Array.isArray(valor)) {
        for (const linea of valor) {
          const texto = asText(linea);
          if (texto) mrzFromFields.push(texto);
        }
      } else {
        const linea = asText(valor);
        if (linea) mrzFromFields.push(linea);
      }
      continue;
    }

    const canonico = FIELD_ALIASES[normalizado];
    if (!canonico) {
      warnings.push(verificationError("OCR_FIELD_UNKNOWN", { field: nombre }));
      continue;
    }
    if (!permitidos.has(canonico)) {
      warnings.push(
        verificationError("OCR_FIELD_UNKNOWN", {
          field: `${nombre} (no se pide en ${slot})`,
        }),
      );
      continue;
    }

    const entrada = readFieldEntry(valorCrudo);
    const texto = entrada ? asText(entrada.valor) : null;
    if (!texto) continue;

    const value = normalizeValue(canonico, texto);
    if (value === null) {
      warnings.push(
        verificationError("OCR_FIELD_UNPARSEABLE", {
          field: nombre,
          value: sample(texto, 30),
          expected: EXPECTED[canonico],
        }),
      );
    }

    const { box, warning } = readBox(entrada?.caja, nombre);
    if (warning) warnings.push(warning);

    fields[canonico] = {
      raw: texto,
      value,
      ...(asText(entrada?.etiqueta)
        ? { label: asText(entrada?.etiqueta)! }
        : {}),
      ...(box ? { box } : {}),
      ...(typeof entrada?.legible === "boolean"
        ? { legible: entrada.legible }
        : {}),
    };
  }

  return { fields, mrzFromFields };
}

/**
 * Proyecta la lectura rica al tipo que consume el cruce.
 *
 * El cruce y todo lo que ya estaba escrito hablan `OcrExtraction`, que es
 * plano. La evidencia (posiciones, rótulos, texto crudo) viaja en campos
 * opcionales aparte: nada de lo viejo se entera, y el diagnóstico la tiene
 * toda disponible.
 */
export function toOcrExtraction(read: OcrDocumentRead): OcrExtraction {
  const fields: OcrFields = {};
  const put = (
    key: Exclude<keyof OcrFields, "mrzLines">,
    field: CanonicalField,
  ) => {
    const valor = read.fields[field];
    if (valor) fields[key] = valor.raw;
  };

  put("apellido", "lastName");
  put("nombre", "firstName");
  put("sexo", "sex");
  put("nroDocumento", "documentNumber");
  put("fechaNacimiento", "birthDate");
  put("fechaVencimiento", "expiryDate");
  put("domicilio", "address");
  put("cuil", "cuil");
  if (read.mrzLines.length > 0) fields.mrzLines = read.mrzLines;

  return {
    classifiedAs: read.classifiedAs,
    fields,
    evidence: read.fields,
    rawText: read.rawText,
    warnings: read.warnings,
  };
}

/**
 * El camino inverso: de la forma plana a la lectura rica.
 *
 * Hace falta en dos lugares: para levantar las filas viejas de la columna
 * `extracted` —que se guardaron antes de que existiera la evidencia— y para
 * que los fakes de los tests puedan describir una lectura en dos líneas en vez
 * de armar la respuesta completa de un modelo.
 */
export function fromOcrExtraction(
  slot: DocumentSlot,
  extraction: OcrExtraction,
): OcrDocumentRead {
  const fields: Partial<Record<CanonicalField, OcrFieldValue>> = {};

  for (const [nombre, valor] of Object.entries(extraction.fields)) {
    if (nombre === "mrzLines" || typeof valor !== "string") continue;
    const canonico = FIELD_ALIASES[key(nombre)];
    if (!canonico) continue;
    fields[canonico] = { raw: valor, value: normalizeValue(canonico, valor) };
  }

  return {
    slot,
    classifiedAs: extraction.classifiedAs,
    classifiedAsRaw: extraction.classifiedAs,
    fields,
    mrzLines: extraction.fields.mrzLines ?? [],
    rawText: extraction.rawText ?? null,
    observations: null,
    warnings: extraction.warnings ?? [],
    model: null,
    durationMs: 0,
  };
}
