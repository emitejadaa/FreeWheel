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
import { normalizeEmail } from "../../common/utils/email.util";
import {
  PASSWORD_LENGTH_MESSAGE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "./password-policy";

export class RegisterCompleteDto {
  // Tiene que quedar igual que en /auth/register/start: es la dirección con la
  // que se guardó el código pendiente.
  @Transform(({ value }: { value: unknown }) => normalizeEmail(value) ?? value)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** Six-digit code sent by POST /auth/register/start. */
  @IsString()
  @Length(6, 6)
  code!: string;

  /** Ver PASSWORD_MIN_LENGTH: la misma regla en todo lugar que pone una. */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_LENGTH_MESSAGE })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: PASSWORD_LENGTH_MESSAGE })
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
