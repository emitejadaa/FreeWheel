import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { VerificationStatus } from "@prisma/client";
import { REQUIRE_VERIFIED_ACCOUNT_KEY } from "../decorators/require-verified-account.decorator";
import { REQUIRE_DRIVING_ELIGIBILITY_KEY } from "../decorators/require-driving-eligibility.decorator";
import { evaluateDrivingEligibility } from "../../verification/identity/driving-eligibility";
import type { CurrentUserPayload } from "../types/current-user.type";

/**
 * Blocks sensitive actions (bookings, payments, publishing, ...) for accounts
 * that are not fully verified. Reads the flag set by @RequireVerifiedAccount()
 * and the verificationStatus that JwtStrategy already loads per request — no
 * extra DB query. Must run AFTER JwtAuthGuard (guard order in @UseGuards), so
 * it cannot be registered globally.
 *
 * También aplica @RequireDrivingEligibility(), que es un control distinto:
 * estar verificado es sobre la identidad, estar habilitado es sobre la
 * licencia. Los dos viven en el mismo guard porque los dos se resuelven con lo
 * que JwtStrategy ya trajo, y porque tenerlos juntos hace evidente que son dos
 * cosas y no una.
 *
 * La lógica de si una licencia habilita vive en verification/identity: este
 * guard la llama, no la reimplementa. Es un import de una función pura, no de
 * un módulo de Nest, así que no crea ninguna dependencia circular entre
 * módulos.
 */
@Injectable()
export class VerifiedAccountGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_VERIFIED_ACCOUNT_KEY,
      [context.getHandler(), context.getClass()],
    );
    const needsLicense = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_DRIVING_ELIGIBILITY_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required && !needsLicense) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      user?: CurrentUserPayload;
    }>();
    const user = request.user;

    if (!user) {
      return false;
    }

    if (required && user.verificationStatus !== VerificationStatus.VERIFIED) {
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

    if (needsLicense) {
      const eligibility = evaluateDrivingEligibility(user);
      if (!eligibility.canRent) {
        // Un 403 que explica CADA motivo, no uno genérico: el usuario tiene
        // que poder leer en pantalla que su licencia venció el 3 de marzo y
        // qué hacer, sin escribirle a nadie. `reasons` viene con código
        // estable (para que el front ramifique) y mensaje en castellano (para
        // mostrarlo tal cual).
        throw new ForbiddenException({
          statusCode: 403,
          code: "DRIVING_NOT_ALLOWED",
          message: eligibility.reasons.map((r) => r.message).join(" "),
          reasons: eligibility.reasons,
          licenseExpiresAt: eligibility.licenseExpiresAt,
        });
      }
    }

    return true;
  }
}
