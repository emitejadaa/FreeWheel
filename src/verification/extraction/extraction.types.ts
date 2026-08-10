import { DniBarcodeData } from "./dni-pdf417.parser";
import { LicenseCodeData } from "./license-code.parser";
import { MrzData } from "./mrz-td1.parser";

/** Los cuatro lados que el usuario sube, uno por columna de UserVerification. */
export type DocumentSlot =
  | "dni_front"
  | "dni_back"
  | "license_front"
  | "license_back";

/**
 * Campos que el OCR intenta leer de una foto. Todos opcionales: el modelo
 * devuelve lo que llega a leer y el cruce trata lo ausente como fuente no
 * disponible (nunca como fraude).
 */
export interface OcrFields {
  apellido?: string;
  nombre?: string;
  sexo?: string;
  nroDocumento?: string;
  fechaNacimiento?: string;
  fechaVencimiento?: string;
  domicilio?: string;
  cuil?: string;
  /** Las 3 líneas del MRZ del dorso del DNI, tal cual se ven. */
  mrzLines?: string[];
}

export interface OcrExtraction {
  /**
   * Qué documento/lado cree el modelo que es la foto. Sirve para detectar una
   * imagen subida en el slot equivocado; "unknown" cuando no puede decidir.
   */
  classifiedAs: DocumentSlot | "unknown";
  fields: OcrFields;
}

/** Todo lo extraído de una submission, por fuente. */
export interface DocumentExtraction {
  /** PDF417 del frente del DNI: fuente autoritativa determinística. */
  dniBarcode: DniBarcodeData | null;
  /** MRZ del dorso: autoritativa solo si sus check digits cierran. */
  mrz: MrzData | null;
  /** QR/PDF417 del dorso de la licencia: informativo. */
  licenseCode: LicenseCodeData | null;
  ocr: Partial<Record<DocumentSlot, OcrExtraction | null>>;
}
