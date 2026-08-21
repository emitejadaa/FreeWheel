import { VerificationError } from "../../errors/verification-errors";
import { DocumentSlot } from "../extraction.types";

/**
 * Los datos que puede traer un documento, con UN nombre por dato.
 *
 * El modelo contesta con los nombres que están impresos en el documento
 * ("apellido", "fecha de nacimiento"); acá adentro cada uno tiene un nombre
 * canónico, y la traducción entre los dos mundos vive en una tabla de alias.
 * Así, si el modelo un día contesta "nombres" en vez de "nombre", el dato no
 * se pierde en silencio.
 */
export type CanonicalField =
  | "lastName"
  | "firstName"
  | "sex"
  | "documentNumber"
  | "birthDate"
  | "issueDate"
  | "expiryDate"
  | "address"
  | "cuil"
  | "procedureNumber"
  | "copy"
  | "licenseClass"
  | "licenseNumber";

/**
 * Qué se le pide leer en cada lado. Lo que el modelo devuelva fuera de esta
 * lista se descarta con una advertencia: el vocabulario cerrado es lo que
 * impide que una respuesta creativa se cuele como si fuera un dato del
 * documento.
 */
export const SLOT_VOCABULARY: Readonly<
  Record<DocumentSlot, readonly CanonicalField[]>
> = {
  dni_front: [
    "lastName",
    "firstName",
    "sex",
    "documentNumber",
    "birthDate",
    "issueDate",
    "expiryDate",
    "procedureNumber",
    "copy",
  ],
  dni_back: ["address", "cuil", "procedureNumber"],
  license_front: [
    "lastName",
    "firstName",
    "documentNumber",
    "birthDate",
    "expiryDate",
    "address",
    "licenseClass",
    "licenseNumber",
  ],
  license_back: ["expiryDate", "licenseClass"],
};

/** Posición del dato en la foto, en milésimos del ancho y del alto (0..1000). */
export interface OcrBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrFieldValue {
  /** Tal cual lo transcribió el modelo. */
  raw: string;
  /**
   * Normalizado para poder compararlo: fechas en ISO, DNI sin puntos, sexo en
   * M/F. `null` cuando el valor no se pudo interpretar — el `raw` queda igual,
   * y la advertencia dice qué pasó.
   */
  value: string | null;
  /** El rótulo impreso al lado del dato, si el modelo lo informó. */
  label?: string;
  /** Dónde estaba en la foto. Solo se pide en el diagnóstico. */
  box?: OcrBox;
  /** Autoevaluación del modelo. Sirve como pista, nunca para decidir. */
  legible?: boolean;
}

/** Todo lo que el modelo leyó de UNA foto. */
export interface OcrDocumentRead {
  slot: DocumentSlot;
  /** Qué documento y lado dice el modelo que es la foto. */
  classifiedAs: DocumentSlot | "unknown";
  /** Lo que contestó antes de traducirlo, para detectar cambios del modelo. */
  classifiedAsRaw: string | null;
  fields: Partial<Record<CanonicalField, OcrFieldValue>>;
  /** Las tres líneas del MRZ del dorso del DNI, aparte porque son un array. */
  mrzLines: string[];
  /** Todo el texto que se ve, recortado. Solo para mirarlo. */
  rawText: string | null;
  /** Lo que el modelo quiso aclarar de la foto ("hay brillo en una esquina"). */
  observations: string | null;
  /** Todo lo que se descartó o no se pudo interpretar, con su motivo. */
  warnings: VerificationError[];
  model: string | null;
  durationMs: number;
}
