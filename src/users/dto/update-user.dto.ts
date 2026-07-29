import { Transform } from "class-transformer";
import {
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from "class-validator";
import {
  IsArgentinePhone,
  normalizeArgentinePhone,
} from "../../common/validators/argentine-phone.validator";

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  /**
   * Teléfono argentino completo con código de país (54 9 11 3289 5416). Se
   * normaliza antes de validar, así queda guardado siempre en el mismo formato
   * sin importar cómo lo haya escrito la persona.
   */
  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) => normalizeArgentinePhone(value) ?? value,
  )
  @IsArgentinePhone()
  phone?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  profilePhotoUrl?: string;
}
