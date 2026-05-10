import { IsString, IsUUID, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  token!: string;

  @IsUUID()
  userId!: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;
}