import { Transform } from "class-transformer";
import { IsEmail, IsString, Length, MaxLength } from "class-validator";
import { normalizeEmail } from "../../common/utils/email.util";

/**
 * La dirección NUEVA a la que se quiere pasar la cuenta.
 *
 * Antes el controller recibía `body: { newEmail: string }` sin DTO, así que el
 * ValidationPipe no miraba nada: entraba cualquier texto y terminaba guardado
 * como email de la cuenta. Con el email roto no hay forma de recuperar la
 * contraseña, o sea que se perdía el acceso.
 *
 * Se normaliza a minúsculas acá porque el email es único en la base: si entrara
 * "Juan@Mail.com" y existiera "juan@mail.com", el control de duplicados no
 * encontraría nada y el cambio fallaría recién al escribir, con un error de base
 * de datos en vez de un mensaje entendible.
 */
export class RequestEmailChangeDto {
  @Transform(({ value }: { value: unknown }) => normalizeEmail(value) ?? value)
  @IsEmail({}, { message: "Escribí una dirección de email válida" })
  @MaxLength(254)
  newEmail!: string;
}

export class ConfirmEmailChangeDto {
  @IsString()
  @Length(6, 6, { message: "El código tiene 6 dígitos" })
  code!: string;
}
