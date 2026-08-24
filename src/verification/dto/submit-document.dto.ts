import { IsString, IsUrl, MaxLength } from "class-validator";

/**
 * Las dos fotos de UN documento (frente y dorso), como las URLs canónicas
 * que devolvió la subida firmada. El backend valida que sean nuestras, del
 * slot correcto y de esta cuenta antes de aceptar nada.
 */
export class SubmitDocumentDto {
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  frontUrl!: string;

  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  backUrl!: string;
}
