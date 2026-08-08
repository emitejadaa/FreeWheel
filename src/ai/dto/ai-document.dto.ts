import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { SUPPORTED_LANGS, type SupportedLang } from "../ai.service";

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

  /**
   * Idioma en el que la IA tiene que escribir el motivo. Es lo que la persona lee
   * para saber qué arreglar en la foto, así que va en el idioma que eligió.
   */
  @IsOptional()
  @IsIn(SUPPORTED_LANGS)
  lang?: SupportedLang;
}
