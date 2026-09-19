import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class CreateDamageClaimDto {
  /**
   * Qué le pasó al auto, escrito por el dueño.
   *
   * El mínimo no es burocracia: este texto es LO QUE VA A LEER quien alquiló
   * cuando le descuenten plata de su garantía, y también lo único que un
   * administrador tiene para decidir. "Rayón" no alcanza para ninguna de las
   * dos cosas; "rayón profundo en la puerta trasera izquierda, no estaba en
   * las fotos del retiro" sí.
   */
  @IsString()
  @MinLength(30, {
    message:
      "Contá qué pasó con un poco de detalle: lo va a leer quien alquiló y " +
      "es lo que decide si se le cobra o no.",
  })
  @MaxLength(1000)
  description!: string;

  /**
   * Cuánto se reclama, EN CENTAVOS.
   *
   * No es lo que se cobra: es lo que se pide. Lo que efectivamente se captura
   * lo decide un administrador y puede ser menos. Va en centavos porque es la
   * unidad con la que trabaja el procesador, y convertir en un solo lugar
   * —el front— evita dos redondeos sobre plata ajena.
   */
  @IsInt()
  @Min(1)
  claimedAmountMinor!: number;

  /**
   * Las fotos del daño, ya subidas.
   *
   * Obligatoria al menos una, por el mismo motivo que en los reportes: sin
   * fotos es la palabra de uno contra la del otro, y acá hay plata de por
   * medio. Las fotos del retiro son la referencia contra la que se compara.
   */
  @IsArray()
  @ArrayMinSize(1, {
    message: "Subí al menos una foto del daño: sin fotos no se puede reclamar.",
  })
  @ArrayMaxSize(6, { message: "Podés subir hasta 6 fotos" })
  @IsUrl(
    { require_protocol: true, protocols: ["http", "https"] },
    { each: true },
  )
  @MaxLength(2048, { each: true })
  evidenceUrls!: string[];
}
