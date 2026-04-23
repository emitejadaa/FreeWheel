import { IsString, Length, Matches, ValidateIf } from 'class-validator';

export class VerifyEmailDto {
  @ValidateIf((value) => !value.token)
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos.' })
  code?: string;

  @ValidateIf((value) => !value.code)
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos.' })
  token?: string;
}
