import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { VerificationStatus } from "@prisma/client";
import { REQUIRE_VERIFIED_ACCOUNT_KEY } from "../decorators/require-verified-account.decorator";
import type { CurrentUserPayload } from "../types/current-user.type";

/**
 * Blocks sensitive actions (bookings, payments, publishing, ...) for accounts
 * that are not fully verified. Reads the flag set by @RequireVerifiedAccount()
 * and the verificationStatus that JwtStrategy already loads per request — no
 * extra DB query. Must run AFTER JwtAuthGuard (guard order in @UseGuards), so
 * it cannot be registered globally.
 */
@Injectable()
export class VerifiedAccountGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_VERIFIED_ACCOUNT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      user?: CurrentUserPayload;
    }>();
    const user = request.user;

    if (!user) {
      return false;
    }

    if (user.verificationStatus !== VerificationStatus.VERIFIED) {
      // Structured 403 so the frontend can route the user into the
      // verification flow (GET /verification/me/status has the checklist).
      throw new ForbiddenException({
        statusCode: 403,
        code: "ACCOUNT_NOT_VERIFIED",
        message:
          "Tu cuenta debe estar verificada (teléfono, DNI y licencia) para realizar esta acción",
        verificationStatus: user.verificationStatus,
      });
    }

    return true;
  }
}
