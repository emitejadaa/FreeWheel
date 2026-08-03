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

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
