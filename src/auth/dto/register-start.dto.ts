import { IsEmail, MaxLength } from "class-validator";

export class RegisterStartDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
