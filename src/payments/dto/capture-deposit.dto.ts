import { IsInt, IsString, MaxLength, Min, MinLength } from "class-validator";

/**
 * Cobrar parte del depósito en garantía por un daño.
 *
 * El importe va en CENTAVOS y entero, como todos los importes que salen hacia
 * el procesador. Recibirlo en pesos con decimales obligaría a redondear acá, y
 * un redondeo sobre plata de otra persona es la clase de detalle que después
 * nadie puede explicar.
 *
 * El motivo es obligatorio y largo: es lo que va a leer quien alquiló cuando
 * pregunte por qué le cobraron la garantía, y "daño" no es una respuesta.
 */
export class CaptureDepositDto {
  @IsInt({ message: "amountMinor debe ser un entero en centavos" })
  @Min(1)
  amountMinor!: number;

  @IsString()
  @MinLength(10, {
    message:
      "reason tiene que explicar el daño: es lo que va a leer quien alquiló",
  })
  @MaxLength(500)
  reason!: string;
}
