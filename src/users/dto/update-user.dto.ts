import {
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import { IsCuil } from "../../common/validators/is-cuil.validator";

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

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  // Identidad manual requerida para la verificación documental: debe
  // coincidir con lo extraído del DNI y la licencia. Inmutable una vez
  // VERIFIED (403 IDENTITY_FIELDS_LOCKED en el servicio).
  @IsOptional()
  @Matches(/^\d{7,8}$/, {
    message: "dni debe tener 7 u 8 dígitos, sin puntos",
  })
  dni?: string;

  @IsOptional()
  @IsCuil()
  cuil?: string;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  profilePhotoUrl?: string;
}
