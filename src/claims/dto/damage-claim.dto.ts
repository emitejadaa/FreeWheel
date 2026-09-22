import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/**
 * ABRIR UN RECLAMO POR DAÑOS.
 *
 * Las fotos son obligatorias y son el corazón del reclamo: sin ellas, cobrar
 * del depósito sería la palabra de uno contra la del otro, y quien decide
 * —primero quien alquiló, después un administrador— no tendría nada que mirar.
 */
export class OpenDamageClaimDto {
  @IsString()
  @MinLength(20, {
    message:
      "description tiene que explicar el daño: es lo que va a leer quien alquiló",
  })
  @MaxLength(2000)
  description!: string;

  @IsInt({ message: "amountRequestedMinor debe ser un entero en centavos" })
  @Min(1)
  amountRequestedMinor!: number;

  @IsArray()
  @ArrayMinSize(1, { message: "Hace falta al menos una foto del daño" })
  @ArrayMaxSize(10)
  @IsUrl({ require_protocol: true }, { each: true })
  @MaxLength(2048, { each: true })
  evidenceUrls!: string[];
}

/** La respuesta de quien alquiló: lo acepta o lo rechaza. */
export class RespondDamageClaimDto {
  @IsBoolean()
  accept!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  response?: string;
}

/** La resolución de un administrador. Puede aprobar menos de lo reclamado. */
export class ResolveDamageClaimDto {
  @IsInt({ message: "approvedAmountMinor debe ser un entero en centavos" })
  @Min(0)
  approvedAmountMinor!: number;

  @IsString()
  @MinLength(20, {
    message:
      "note tiene que explicar la decisión: la van a leer las dos partes",
  })
  @MaxLength(2000)
  note!: string;
}
