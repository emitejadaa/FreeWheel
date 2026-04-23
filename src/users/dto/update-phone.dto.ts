import { IsString, Matches } from 'class-validator';

export class UpdatePhoneDto {
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'El teléfono debe estar en formato internacional válido.',
  })
  phoneNumber!: string;
}
