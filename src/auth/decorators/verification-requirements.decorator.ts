import { SetMetadata } from '@nestjs/common';
import { IdentityVerificationStatus } from '@prisma/client';

export const VERIFICATION_REQUIREMENTS_KEY = 'verification_requirements';

export type VerificationRequirements = {
  emailVerified?: boolean;
  phoneVerified?: boolean;
  identityStatuses?: IdentityVerificationStatus[];
};

export const RequireVerification = (
  requirements: VerificationRequirements,
) => SetMetadata(VERIFICATION_REQUIREMENTS_KEY, requirements);
