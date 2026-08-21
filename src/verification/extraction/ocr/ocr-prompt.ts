import { DocumentSlot } from "../extraction.types";
import { CanonicalField, SLOT_VOCABULARY } from "./ocr.types";

/** Cómo se llama cada dato en el JSON que se le pide al modelo, y qué es. */
const PROMPT_FIELD: Record<CanonicalField, { key: string; describe: string }> =
  {
    lastName: { key: "apellido", describe: "el apellido" },
    firstName: { key: "nombres", describe: "el o los nombres de pila" },
    sex: { key: "sexo", describe: 'el sexo, una sola letra: "M" o "F"' },
    documentNumber: {
      key: "nro_documento",
      describe: "el número de documento, solo los dígitos",
    },
    birthDate: {
      key: "fecha_nacimiento",
      describe: "la fecha de nacimiento, como esté impresa",
    },
    issueDate: { key: "fecha_emision", describe: "la fecha de emisión" },
    expiryDate: {
      key: "fecha_vencimiento",
      describe: "la fecha de vencimiento",
    },
    address: {
      key: "domicilio",
      describe: "el domicilio completo: calle, número y localidad",
    },
    cuil: { key: "cuil", describe: "el CUIL, 11 dígitos" },
    procedureNumber: {
      key: "nro_tramite",
      describe: "el número de trámite",
    },
    copy: {
      key: "ejemplar",
      describe: 'el ejemplar (una letra, por ejemplo "A")',
    },
    licenseClass: {
      key: "clase",
      describe: "las clases habilitadas de la licencia",
    },
    licenseNumber: {
      key: "nro_licencia",
      describe: "el número de la licencia, si es distinto del documento",
    },
  };

const SLOT_NAME: Record<DocumentSlot, string> = {
  dni_front: "el FRENTE de un DNI argentino",
  dni_back: "el DORSO de un DNI argentino",
  license_front: "el FRENTE de una licencia de conducir argentina",
  license_back: "el DORSO de una licencia de conducir argentina",
};

/** Qué valores puede tomar "documento" en la respuesta. */
const DOCUMENT_VALUES =
  '"dni_frente" | "dni_dorso" | "licencia_frente" | "licencia_dorso" | "otro"';

export const MAX_RAW_TEXT = 600;

/**
 * Lo que se le pide al modelo para UNA foto.
 *
 * DOS REGLAS QUE NO SE NEGOCIAN:
 *
 * 1. El modelo LEE E INTERPRETA: dice qué dato es cada texto que ve. Eso es
 *    trabajo de lectura y lo hace bien.
 * 2. El modelo NO COMPARA NI VALIDA NADA. No sabe qué cargó la persona en el
 *    formulario, no sabe qué dice el código de barras, y no tiene que opinar
 *    sobre si los datos son correctos. Todo eso lo hace después, en código,
 *    la comparación determinística. Un modelo que además valida es un modelo
 *    que puede rechazar a una persona real por su cuenta, y sin dejar rastro
 *    de por qué.
 *
 * El vocabulario de campos es cerrado (SLOT_VOCABULARY): lo que venga fuera de
 * esa lista se descarta al parsear.
 */
export function buildOcrPrompt(
  slot: DocumentSlot,
  options: { withBoxes?: boolean } = {},
): string {
  const campos = SLOT_VOCABULARY[slot].map((field) => PROMPT_FIELD[field]);
  const conCaja = options.withBoxes === true;

  // La forma de cada campo se describe APARTE del ejemplo de JSON: un ejemplo
  // con comentarios `//` adentro deja de ser JSON, y un modelo que lo copia al
  // pie de la letra devuelve algo que no parsea.
  const formaCampo = conCaja
    ? '{"valor": "...", "etiqueta": "...", "caja": [x, y, ancho, alto], "legible": true}'
    : '{"valor": "...", "etiqueta": "...", "legible": true}';

  return [
    `Mirá esta foto. Se espera que sea ${SLOT_NAME[slot]}.`,
    "",
    "TU ÚNICA TAREA ES LEER. Transcribí lo que está impreso y decí qué dato es",
    "cada cosa. NO compares con nada, NO valides si los datos son correctos y",
    "NO completes lo que no se llega a leer: si un campo no se ve, omitilo.",
    "",
    "Respondé ÚNICAMENTE con un objeto JSON, sin texto ni comentarios alrededor,",
    "con estas cuatro claves:",
    "",
    `"documento": qué documento y lado ves REALMENTE en la imagen, no lo que se`,
    `espera. Uno de: ${DOCUMENT_VALUES}.`,
    "",
    `"campos": un objeto donde cada clave es uno de los datos de la lista de`,
    `abajo y su valor tiene la forma ${formaCampo}.`,
    '"etiqueta" es el rótulo impreso al lado del dato. Omití por completo las',
    "claves que no puedas leer con certeza.",
    ...campos.map((campo) => `  - "${campo.key}": ${campo.describe}`),
    ...(slot === "dni_back"
      ? [
          "",
          '"mrz": un array con las 3 líneas de 30 caracteres del pie del dorso,',
          "transcriptas EXACTAMENTE carácter por carácter, incluidos los signos <.",
        ]
      : []),
    "",
    `"texto_completo": todo el texto que se ve, línea por línea, hasta ${MAX_RAW_TEXT}`,
    "caracteres.",
    "",
    '"observaciones": algo que impida leer bien la foto (brillo, corte, foco), o null.',
    ...(conCaja
      ? [
          "",
          '"caja" es dónde está ese texto en la imagen, en milésimos: [x, y, ancho,',
          "alto], con 0 en el borde superior izquierdo y 1000 en el opuesto.",
        ]
      : []),
  ].join("\n");
}
