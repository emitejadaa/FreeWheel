/**
 * Seam for the identity-document review step. Callers only talk to
 * IdentityReviewService; which reviewer runs behind it is picked by the
 * IDENTITY_REVIEW_MODE env var (auto_approve | manual), mirroring the
 * payments/SMS provider pattern. A future real review (back-office queue, AI
 * document check, external KYC provider) implements this interface and is
 * wired in VerificationModule without touching any caller.
 */

export const IDENTITY_REVIEWER = Symbol("IDENTITY_REVIEWER");

export interface IdentityReviewInput {
  userId: string;
  verificationId: string;
  dniFrontUrl: string;
  dniBackUrl: string;
  licenseFrontUrl: string;
  licenseBackUrl: string;
  selfieUrl?: string | null;
}

export interface IdentityReviewVerdict {
  approved: boolean;
  notes?: string;
}

export interface IdentityReviewer {
  readonly name: string;
  review(input: IdentityReviewInput): Promise<IdentityReviewVerdict>;
}
