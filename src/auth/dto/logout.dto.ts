import { IsString, MinLength } from 'class-validator';

export class LogoutDto {
  @IsString()
  @MinLength(32)
  refreshToken!: string;
}
