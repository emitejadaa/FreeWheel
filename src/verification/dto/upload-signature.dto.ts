import { IsIn } from "class-validator";

/**
 * Qué archivo se está por subir. El servidor arma la carpeta y el public_id
 * a partir del usuario del JWT más estos dos datos: el cliente no elige
 * nada más.
 */
export class UploadSignatureDto {
  @IsIn(["dni", "license"])
  document!: "dni" | "license";

  @IsIn(["front", "back"])
  side!: "front" | "back";
}
