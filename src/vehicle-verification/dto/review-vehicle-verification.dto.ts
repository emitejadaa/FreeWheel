import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Veredicto de un admin sobre la verificación de un auto. APPROVED lo habilita
 * a publicarse; REJECTED lo rechaza y borra las fotos de la cédula.
 *
 * Las notas son internas: no se le muestran al dueño. Quien revisa tiene que
 * poder escribir "sospecha de mellizo, la patente figura en otro auto" sin que
 * eso le llegue justamente a quien habría que investigar.
 */
export class ReviewVehicleVerificationDto {
  @IsIn(["APPROVED", "REJECTED"])
  status!: "APPROVED" | "REJECTED";

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
