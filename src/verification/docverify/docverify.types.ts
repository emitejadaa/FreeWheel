/**
 * EL CONTRATO CON EL VERIFICADOR DE DOCUMENTOS
 *
 * Cada foto devuelve un objeto por protocolo de extracción (OCR, PDF417, MRZ,
 * según el caso), con `title` y SIEMPRE todos los atributos extraíbles de ese
 * caso (null cuando no se detectaron). El vocabulario de nombres es único,
 * así `nombre` se compara contra `nombre` sin importar de qué documento ni
 * protocolo salió. El verificador que implemente este contrato (ver
 * PythonDocverifyService) todavía no existe; este archivo es la especificación
 * de lo que tiene que devolver cuando exista.
 */

export const DOCUMENT_SLOTS = [
  "dni_front",
  "dni_back",
  "license_front",
  "license_back",
] as const;

export type DocumentSlot = (typeof DOCUMENT_SLOTS)[number];

/** Un protocolo entero que falló trae el motivo; los campos quedan null. */
export interface DocverifyProtocolError {
  code: string;
  message: string;
}

interface ProtocolBase {
  title: string;
  error?: DocverifyProtocolError;
}

/** OCR del frente del DNI. */
export interface DniFrontOcr extends ProtocolBase {
  title: "ocr";
  apellido: string | null;
  nombre: string | null;
  sexo: string | null;
  nDocumento: string | null;
  fechaNacimiento: string | null;
  fechaEmision: string | null;
  fechaVencimiento: string | null;
}

/** PDF417 del frente del DNI (no trae vencimiento: no está en el código). */
export interface DniFrontCodigo extends ProtocolBase {
  title: "codigo";
  apellido: string | null;
  nombre: string | null;
  sexo: string | null;
  nDocumento: string | null;
  fechaNacimiento: string | null;
  fechaEmision: string | null;
}

/** OCR del dorso del DNI (domicilio y CUIL solo existen impresos ahí). */
export interface DniBackOcr extends ProtocolBase {
  title: "ocr";
  domicilio: string | null;
  cuil: string | null;
}

/** MRZ del dorso del DNI. Solo llega con datos si sus verificadores cierran. */
export interface DniBackMrz extends ProtocolBase {
  title: "mrz";
  apellido: string | null;
  nombre: string | null;
  sexo: string | null;
  nDocumento: string | null;
  fechaNacimiento: string | null;
  fechaVencimiento: string | null;
}

/** OCR del frente de la licencia. */
export interface LicenseFrontOcr extends ProtocolBase {
  title: "ocr";
  numLicencia: string | null;
  apellido: string | null;
  nombre: string | null;
  domicilio: string | null;
  fechaNacimiento: string | null;
  fechaVencimiento: string | null;
}

/** OCR del dorso de la licencia: CUIL y leyenda de principiante. */
export interface LicenseBackOcr extends ProtocolBase {
  title: "ocr";
  cuil: string | null;
  esPrincipiante: boolean | null;
  finPrincipiante: string | null;
}

export interface DniFrontResult {
  ocr: DniFrontOcr;
  codigo: DniFrontCodigo;
  /** La foto ni siquiera se pudo abrir/procesar. */
  error?: DocverifyProtocolError;
}

export interface DniBackResult {
  ocr: DniBackOcr;
  mrz: DniBackMrz;
  error?: DocverifyProtocolError;
}

export interface LicenseFrontResult {
  ocr: LicenseFrontOcr;
  error?: DocverifyProtocolError;
}

export interface LicenseBackResult {
  ocr: LicenseBackOcr;
  error?: DocverifyProtocolError;
}

export interface DocverifyResponse {
  ok: boolean;
  version?: string;
  documentos?: {
    dni_front?: DniFrontResult;
    dni_back?: DniBackResult;
    license_front?: LicenseFrontResult;
    license_back?: LicenseBackResult;
  };
  error?: DocverifyProtocolError;
}

/** Lo que necesita el matcher del flujo DNI. */
export interface DniDocverifyResult {
  dni_front: DniFrontResult;
  dni_back: DniBackResult;
}

/** Lo que necesita el matcher del flujo licencia. */
export interface LicenseDocverifyResult {
  license_front: LicenseFrontResult;
  license_back: LicenseBackResult;
}
