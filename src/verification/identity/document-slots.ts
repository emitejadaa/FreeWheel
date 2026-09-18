/**
 * EL VOCABULARIO DE LAS FOTOS.
 *
 * Las cuatro imágenes que se pueden subir, con el nombre que usan por igual el
 * storage (es el prefijo del public_id), el front (es lo que pide la firma de
 * subida) y los motivos de error (es lo que dice qué foto hay que repetir).
 *
 * Vive en su propio archivo y no dentro del servicio que maneja los archivos
 * porque lo necesita también el catálogo de motivos, que no tiene por qué
 * depender de Cloudinary para poder nombrar una foto.
 */

/** Tipo de documento en minúscula, como viaja en las URLs y los public_id. */
export type DocumentKind = "dni" | "license";

export const DOCUMENT_SLOTS = [
  "dni_front",
  "dni_back",
  "license_front",
  "license_back",
] as const;

export type DocumentSlot = (typeof DOCUMENT_SLOTS)[number];

export type DocumentSide = "front" | "back";

export function slotFor(kind: DocumentKind, side: DocumentSide): DocumentSlot {
  return `${kind}_${side}`;
}

/** Las dos fotos de un documento, en el orden en que se piden. */
export function slotsOf(kind: DocumentKind): DocumentSlot[] {
  return [slotFor(kind, "front"), slotFor(kind, "back")];
}

/**
 * Cómo nombra la API de lectura cada cara ("frente" / "dorso") → nuestro slot.
 *
 * Es la traducción que permite decirle al usuario "sacá de nuevo la foto del
 * dorso de tu licencia" a partir de un problema que la API reportó sobre una
 * cara. Sin esto, un error de lectura sabía en qué cara pasó pero no podía
 * nombrar la foto que el usuario tiene que repetir.
 */
export function slotForFace(
  kind: DocumentKind,
  face: string,
): DocumentSlot | null {
  const normalizada = face.trim().toLowerCase();
  if (normalizada === "frente") return slotFor(kind, "front");
  if (normalizada === "dorso") return slotFor(kind, "back");
  return null;
}
