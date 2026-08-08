import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { SUPPORTED_LANGS, type SupportedLang } from "../ai.service";

export class AiVisionDto {
  @IsString()
  @MaxLength(3_000_000)
  imageDataUrl!: string;

  /**
   * Idioma en el que la IA tiene que escribir el motivo del rechazo. Es texto que
   * la persona LEE en la pantalla, así que sigue el idioma que eligió en la app.
   * Opcional: sin idioma se usa castellano, como antes.
   */
  @IsOptional()
  @IsIn(SUPPORTED_LANGS)
  lang?: SupportedLang;
}
