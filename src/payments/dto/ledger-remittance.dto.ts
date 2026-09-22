import {
  IsInt,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/**
 * Registrar un pago hecho POR FUERA del procesador (una transferencia a la
 * aseguradora, un pago a quien alquiló). `reference` es el comprobante de ese
 * pago —el número de transferencia— y es también lo que impide registrarlo dos
 * veces: dos pedidos con la misma referencia son el mismo pago.
 */
export class LedgerRemittanceDto {
  @IsInt({ message: "amountMinor debe ser un entero en centavos" })
  @Min(1)
  amountMinor!: number;

  @IsString()
  @Matches(/^[a-z]{3}$/, {
    message: "currency debe ser un código ISO de 3 letras en minúscula",
  })
  currency!: string;

  @IsString()
  @MinLength(4)
  @MaxLength(120)
  reference!: string;
}
