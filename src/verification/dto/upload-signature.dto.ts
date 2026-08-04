import { IsIn, IsOptional } from "class-validator";

export const IDENTITY_DOCUMENTS = ["dni", "license", "selfie"] as const;
export const IDENTITY_SIDES = ["front", "back"] as const;

export type IdentityDocument = (typeof IDENTITY_DOCUMENTS)[number];
export type IdentitySide = (typeof IDENTITY_SIDES)[number];

/**
 * Pedido de firma de subida para UN archivo de identidad concreto. El cliente
 * solo elige documento y lado; carpeta, public_id y tipo de entrega
 * (authenticated) los fija el servidor — así el slot queda ligado
 * estructuralmente al archivo y es imposible confundir DNI con licencia o
 * frente con dorso.
 *
 * "selfie" no lleva lado (queda reservada para la verificación de rostro).
 */
export class UploadSignatureDto {
  @IsIn(IDENTITY_DOCUMENTS)
  document!: IdentityDocument;

  // Obligatorio para dni y license, prohibido para selfie: lo valida el service.
  @IsOptional()
  @IsIn(IDENTITY_SIDES)
  side?: IdentitySide;
}
