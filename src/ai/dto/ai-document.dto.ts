import { IsIn, IsString, MaxLength } from "class-validator";

/**
 * Revisión de una foto de documento. `image` acepta una URL pública (Cloudinary)
 * o un dataURL en base64, para poder revisar la foto antes de subirla.
 */
export class AiDocumentDto {
  @IsString()
  @MaxLength(3_000_000)
  image!: string;

  @IsIn(["DNI_FRONT", "DNI_BACK", "LICENSE_FRONT", "LICENSE_BACK"])
  kind!: "DNI_FRONT" | "DNI_BACK" | "LICENSE_FRONT" | "LICENSE_BACK";
}
