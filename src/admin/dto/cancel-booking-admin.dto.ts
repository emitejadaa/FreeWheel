import { IsString, MaxLength, MinLength } from "class-validator";

/**
 * El motivo es OBLIGATORIO y tiene que explicar algo.
 *
 * Una devolución total hecha desde el panel, sin motivo escrito, es justo lo
 * que nadie va a poder explicar seis meses después. Diez caracteres es poco
 * para un relato y alcanza para que "ok" o un punto no pasen.
 */
export class CancelBookingAdminDto {
  @IsString()
  @MinLength(10, {
    message: "Escribí por qué se cancela: queda en el registro.",
  })
  @MaxLength(500)
  reason!: string;
}
