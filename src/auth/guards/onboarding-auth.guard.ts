import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/**
 * For the onboarding endpoints (verify-email, resend-verification,
 * complete-profile): accepts a full token OR an onboarding token, so both a
 * mid-onboarding user and an already-logged-in legacy user can finish the flow.
 */
@Injectable()
export class OnboardingAuthGuard extends AuthGuard(["jwt", "jwt-onboarding"]) {}
