import { SetMetadata } from "@nestjs/common";

export const REQUIRE_VERIFIED_ACCOUNT_KEY = "requireVerifiedAccount";

/**
 * Marks a route as sensitive: only fully verified accounts
 * (verificationStatus === VERIFIED: email + phone + identity documents + date
 * of birth) may call it. Enforced by VerifiedAccountGuard, which must be listed
 * after JwtAuthGuard in @UseGuards.
 */
export const RequireVerifiedAccount = () =>
  SetMetadata(REQUIRE_VERIFIED_ACCOUNT_KEY, true);
