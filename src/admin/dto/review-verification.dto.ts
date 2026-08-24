import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Veredicto de un admin sobre una verificación documental. APPROVED aprueba
 * el documento; REJECTED lo rechaza y borra sus archivos del storage.
 */
export class ReviewVerificationDto {
  @IsIn(["APPROVED", "REJECTED"])
  status!: "APPROVED" | "REJECTED";

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
