import { IsString, Matches } from 'class-validator';

export class AddMobileDto {
  @IsString()
  @Matches(/^\+?[1-9]\d{1,14}$/, {
    message: 'El número de teléfono debe ser válido (formato E.164)',
  })
  mobile!: string;
}
