import { IsUrl, MaxLength } from "class-validator";

/**
 * URL del audio a transcribir. Es la que devuelve Cloudinary al subir la nota de
 * voz del chat: el backend la descarga y se la manda a Whisper.
 */
export class AiTranscribeDto {
  @IsUrl({ require_protocol: true, protocols: ["http", "https"] })
  @MaxLength(2048)
  audioUrl!: string;
}
