import { Transform } from "class-transformer";
import { IsEmail, MaxLength } from "class-validator";
import { normalizeEmail } from "../../common/utils/email.util";

export class RegisterStartDto {
  // A minúsculas y sin espacios antes de validar: es la única forma en que el
  // email se guarda, así que también es la única con la que se lo busca.
  @Transform(({ value }: { value: unknown }) => normalizeEmail(value) ?? value)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
