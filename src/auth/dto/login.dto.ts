import { Transform } from "class-transformer";
import { IsEmail, IsString, MinLength } from "class-validator";
import { normalizeEmail } from "../../common/utils/email.util";

export class LoginDto {
  // Escribir el mail con una mayúscula no puede ser el motivo por el que
  // alguien no pueda entrar a su cuenta.
  @Transform(({ value }: { value: unknown }) => normalizeEmail(value) ?? value)
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}
