import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from "class-validator";
import type { DocumentSlot } from "../extraction/extraction.types";

const SLOTS = ["dni_front", "dni_back", "license_front", "license_back"];

/**
 * Una foto por request, a propósito: la plataforma corta los cuerpos de más de
 * 4,5 MB, y cuatro fotos en base64 no entran. Además, mirar una a la vez es
 * justamente lo que permite ver cuál falla.
 */
export class DiagnoseDocumentDto {
  @IsIn(SLOTS)
  slot!: DocumentSlot;

  /** La foto en base64 (data:image/...;base64,...). */
  @IsOptional()
  @IsString()
  @MaxLength(3_000_000)
  image?: string;

  /** O la URL de un documento YA SUBIDO por esta misma cuenta. */
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  url?: string;

  /** Pedirle al modelo dónde está cada dato, para dibujarlo sobre la foto. */
  @IsOptional()
  @IsBoolean()
  withBoxes?: boolean;
}

/**
 * La comparación se hace con lo que devolvió el diagnóstico foto por foto.
 *
 * `documents` y `profile` se validan a mano (ver diagnose-input.ts) y no con
 * decoradores: el ValidationPipe global tiene `forbidNonWhitelisted`, que a un
 * objeto anidado sin `@ValidateNested` lo vacía en silencio. Un `@IsObject()`
 * pelado lo conserva entero, y los mensajes de error los escribimos nosotros,
 * en castellano y diciendo qué falta.
 */
export class DiagnoseCompareDto {
  /** Una clave por slot, con la respuesta de POST /verification/diagnose/document. */
  @IsObject()
  documents!: Record<string, unknown>;

  /** Datos del formulario. Si no viene, se usan los de la cuenta. */
  @IsOptional()
  @IsObject()
  profile?: Record<string, unknown>;
}
