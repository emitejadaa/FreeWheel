import { IsString, MaxLength, MinLength } from "class-validator";

/**
 * Revisar una señal de reputación inflada.
 *
 * La nota es obligatoria por el mismo motivo que en la cancelación
 * administrativa: acá se decide sobre la cuenta de alguien, y quien la mire
 * dentro de seis meses tiene que poder saber en qué se basó la decisión. "Falso
 * positivo, son dos hermanos" y "lo dejé pasar" no se parecen en nada, y sin la
 * nota las dos se ven igual: una fila resuelta.
 */
export class ResolveFraudSignalDto {
  @IsString()
  @MinLength(5, {
    message:
      "Escribí qué viste. Una señal resuelta sin motivo no sirve después.",
  })
  @MaxLength(500)
  note!: string;
}
