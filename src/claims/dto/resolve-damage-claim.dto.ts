import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class ResolveDamageClaimDto {
  /** true cobra del depósito; false lo rechaza y libera la garantía entera. */
  @IsBoolean()
  aceptar!: boolean;

  /**
   * Cuánto cobrar del depósito, en centavos. Solo cuando se acepta.
   *
   * Puede ser MENOS de lo que el dueño reclamó, y es a propósito: quien
   * resuelve mira las fotos y decide, no firma lo que le pidieron. Más que lo
   * retenido no se puede, y el servicio de pagos además lo recorta.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  amountMinor?: number;

  /**
   * Por qué se resolvió así. Lo leen las dos partes.
   *
   * Es el mismo mínimo que el reclamo y por el mismo motivo: una resolución
   * sin explicación sobre la plata de otro no es una resolución, es una orden.
   */
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  nota!: string;
}
