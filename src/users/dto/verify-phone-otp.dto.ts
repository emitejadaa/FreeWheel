import { IsString, Length, Matches } from 'class-validator';

export class VerifyPhoneOtpDto {
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos.' })
  code!: string;
}
