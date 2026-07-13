import { Logger } from "@nestjs/common";
import {
  IdentityReviewer,
  IdentityReviewInput,
  IdentityReviewVerdict,
} from "./identity-reviewer.interface";

/**
 * TODO: replace with a real review (manual back-office, AI document check, or
 * an external KYC provider). Until then every complete submission is approved
 * automatically so the verified-account flow works end to end. The admin
 * endpoint PATCH /admin/verifications/:id/review remains the manual override.
 *
 * Known consequence, intentional for now: a submission re-sent after an admin
 * REJECTED verdict is auto-approved again.
 */
export class AutoApproveReviewer implements IdentityReviewer {
  readonly name = "auto_approve";

  private readonly logger = new Logger(AutoApproveReviewer.name);

  review(input: IdentityReviewInput): Promise<IdentityReviewVerdict> {
    this.logger.log(
      `Auto-approving identity submission ${input.verificationId} for user ${input.userId}`,
    );
    return Promise.resolve({
      approved: true,
      notes: "Auto-approved (IDENTITY_REVIEW_MODE=auto_approve)",
    });
  }
}
