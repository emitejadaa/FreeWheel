import { SetMetadata } from "@nestjs/common";

export const REQUIRE_VERIFIED_ACCOUNT_KEY = "requireVerifiedAccount";

/**
 * Marks a route as sensitive: only verified accounts (verificationStatus ===
 * VERIFIED: confirmed email + approved DNI, plus the phone when
 * REQUIRE_PHONE_VERIFICATION is on) may call it. Enforced by
 * VerifiedAccountGuard, which must be listed after JwtAuthGuard in @UseGuards.
 */
export const RequireVerifiedAccount = () =>
  SetMetadata(REQUIRE_VERIFIED_ACCOUNT_KEY, true);
