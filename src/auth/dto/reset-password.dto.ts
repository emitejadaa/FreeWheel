import { IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import {
  PASSWORD_LENGTH_MESSAGE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "./password-policy";

export class ResetPasswordDto {
  /**
   * El token del link: 64 caracteres hex. El máximo es holgado a propósito y
   * existe por lo mismo que el de la contraseña: se compara con bcrypt, y no
   * hay por qué pasar un texto enorme por algo que está hecho para ser caro.
   */
  @IsString()
  @MaxLength(256)
  token!: string;

  @IsUUID()
  userId!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_LENGTH_MESSAGE })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: PASSWORD_LENGTH_MESSAGE })
  newPassword!: string;
}
