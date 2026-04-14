import { IsString, Length, Matches } from 'class-validator';

export class VerifyMobileDto {
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'El código debe ser 6 dígitos' })
  verificationCode!: string;
}
