import {
  IdentityReviewer,
  IdentityReviewInput,
  IdentityReviewVerdict,
} from "./identity-reviewer.interface";

/**
 * Never approves automatically: submissions stay ID_SUBMITTED until an admin
 * decides via PATCH /admin/verifications/:id/review.
 */
export class ManualReviewer implements IdentityReviewer {
  readonly name = "manual";

  review(_input: IdentityReviewInput): Promise<IdentityReviewVerdict> {
    return Promise.resolve({ approved: false });
  }
}
