import { Transform } from "class-transformer";
import { IsEmail } from "class-validator";
import { normalizeEmail } from "../../common/utils/email.util";

export class ForgotPasswordDto {
  @Transform(({ value }: { value: unknown }) => normalizeEmail(value) ?? value)
  @IsEmail()
  email!: string;
}
