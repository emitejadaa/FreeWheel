import { IsString, Length } from 'class-validator';

export class ConfirmCodeDto {
  @IsString()
  @Length(6, 12)
  code!: string;
}
