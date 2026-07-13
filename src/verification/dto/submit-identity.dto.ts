import { IsOptional, IsString, IsUrl, MaxLength } from "class-validator";

/**
 * Identity documents for account verification: DNI and driver's license, both
 * sides. Files are uploaded client-side to Cloudinary via
 * POST /media/cloudinary-signature — the backend only receives URLs.
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

  /** Optional selfie, reserved for a future face-match review step. */
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  selfieUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
