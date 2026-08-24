import { IsIn, IsString, MaxLength } from "class-validator";

/**
 * Una URL suelta para diagnosticar antes de mandarla al submit. No valida
 * que sea una URL bien formada a propósito: si el front manda cualquier
 * cosa, la respuesta tiene que explicar QUÉ tiene de malo, no rebotar con
 * un 400 genérico de class-validator.
 */
export class InspectDocumentDto {
  @IsIn(["dni", "license"])
  document!: "dni" | "license";

  @IsIn(["front", "back"])
  side!: "front" | "back";

  @IsString()
  @MaxLength(2048)
  url!: string;
}
