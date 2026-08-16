import { Transform } from "class-transformer";
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from "class-validator";
import {
  IsPhone,
  normalizePhone,
} from "../../common/validators/phone.validator";
import { IsAdultDate } from "../../common/validators/is-adult-date.validator";

export class RegisterCompleteDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** Six-digit code sent by POST /auth/register/start. */
  @IsString()
  @Length(6, 6)
  code!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  /**
   * Teléfono de contacto. Opcional acá, pero es un dato que la cuenta necesita
   * para llegar a estar verificada (el código de verificación se manda a este
   * número), así que se acepta desde el registro para no pedirlo dos veces.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizePhone(value) ?? value)
  @IsPhone()
  phone?: string;

  @IsBoolean()
  @Equals(true, { message: "Debés aceptar los términos y condiciones" })
  acceptedTerms!: boolean;

  /** Birth date as YYYY-MM-DD; only adults (18+) may register. */
  @IsAdultDate()
  dateOfBirth!: string;
}
