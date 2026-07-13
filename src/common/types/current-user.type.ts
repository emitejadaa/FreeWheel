import { UserRole, UserStatus, VerificationStatus } from "@prisma/client";

export interface CurrentUserPayload {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  verificationStatus: VerificationStatus;
  dateOfBirth: Date | null;
  /** Present only when the request was authenticated with an onboarding token. */
  tokenScope?: "onboarding";
}
