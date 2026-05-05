import { IsString, MinLength, MaxLength } from 'class-validator';

export class ConfirmTokenDto {
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  token!: string;
}
