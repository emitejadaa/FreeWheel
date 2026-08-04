import { Logger } from "@nestjs/common";
import {
  IdentityReviewer,
  IdentityReviewInput,
  IdentityReviewVerdict,
} from "./identity-reviewer.interface";

/**
 * Aprueba toda submission completa sin mirar los documentos. Solo sirve para
 * desarrollo y tests: en producción se usa IDENTITY_REVIEW_MODE=document_ai
 * (revisión real), "ai" (revisión liviana por visión) o "manual".
 *
 * Consecuencia conocida, intencional en este modo: una submission reenviada
 * tras un rechazo del admin vuelve a aprobarse sola.
 */
export class AutoApproveReviewer implements IdentityReviewer {
  readonly name = "auto_approve";

  private readonly logger = new Logger(AutoApproveReviewer.name);

  review(input: IdentityReviewInput): Promise<IdentityReviewVerdict> {
    this.logger.log(
      `Auto-approving identity submission ${input.verificationId} for user ${input.userId}`,
    );
    return Promise.resolve({
      outcome: "approved" as const,
      reasonCodes: [],
      notes: "Auto-approved (IDENTITY_REVIEW_MODE=auto_approve)",
    });
  }
}
