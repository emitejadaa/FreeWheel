import { IsOptional, IsString, IsUrl, MaxLength } from "class-validator";

/**
 * Identity documents for account verification: DNI and driver's license, both
 * sides. Each file is uploaded client-side to Cloudinary with a per-slot
 * signature from POST /verification/identity/upload-signature — the backend
 * only receives URLs, and validates that every one of them is an asset it
 * signed for this user and this exact slot.
 */
export class SubmitIdentityDto {
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  dniFrontUrl!: string;

  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  dniBackUrl!: string;

  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  licenseFrontUrl!: string;

  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  licenseBackUrl!: string;

  /**
   * Selfie opcional, reservada para la futura verificación de rostro con prueba
   * de vida. Hoy no participa de la revisión, pero si viene tiene que ser un
   * asset propio firmado por este backend (igual que los documentos): guardar
   * una URL arbitraria que después abre un admin sería un vector de phishing.
   */
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  selfieUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
