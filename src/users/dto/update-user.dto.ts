import { PhotoVisibility } from "@prisma/client";
import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import {
  IsArgentinePhone,
  normalizeArgentinePhone,
} from "../../common/validators/argentine-phone.validator";
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

  // Identidad manual requerida para la verificación documental: debe coincidir
  // con lo extraído del DNI y la licencia. Inmutable una vez que la cuenta es
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

  /**
   * Quién ve la foto de perfil: EVERYONE (cualquiera con la sesión abierta) o
   * BOOKED (solo con quien haya una reserva en común). Se elige en el perfil.
   */
  @IsOptional()
  @IsEnum(PhotoVisibility)
  profilePhotoVisibility?: PhotoVisibility;

  /**
   * Si esta persona quiere recibir avisos por mail: reservas pedidas,
   * aceptadas, pagos, entregas y devoluciones, y el aviso de mensajes sin leer.
   *
   * No apaga los mails de seguridad —el código para entrar, el de cambiar el
   * email, el link para recuperar la contraseña, el código para cambiar el
   * precio—: esos no son avisos, son la forma de poder usar la cuenta.
   */
  @IsOptional()
  @IsBoolean()
  emailNotifications?: boolean;
}
