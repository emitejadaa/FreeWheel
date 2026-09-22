import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { UserStatus } from "@prisma/client";
import { ExtractJwt, Strategy } from "passport-jwt";
import { UsersService } from "../../users/users.service";
import { getJwtSecret, JWT_ALGORITHM } from "../../config/jwt.config";
import {
  emitidoAntesDelCambioDeClave,
  sesionRevocada,
} from "./session-revocation";

interface OnboardingJwtPayload {
  sub: string;
  email: string;
  /** Cuándo se firmó, en segundos. Lo pone jsonwebtoken al firmar. */
  iat?: number;
  scope?: string;
}

/**
 * Accepts ONLY short-lived onboarding tokens (scope: "onboarding"), issued to
 * users who still owe a pre-access step (verify email / provide date of birth).
 * The mirror image of JwtStrategy, which rejects any scoped token — together
 * they keep onboarding tokens usable exclusively on the endpoints that opt in
 * via OnboardingAuthGuard.
 */
@Injectable()
export class JwtOnboardingStrategy extends PassportStrategy(
  Strategy,
  "jwt-onboarding",
) {
  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(configService),
      // Solo el algoritmo con el que firmamos: sin esto passport-jwt acepta
      // el que diga la cabecera del propio token (ver JWT_ALGORITHM).
      algorithms: [JWT_ALGORITHM],
    });
  }

  async validate(payload: OnboardingJwtPayload) {
    if (payload.scope !== "onboarding") {
      throw new UnauthorizedException("Invalid token");
    }

    const user = await this.usersService.findById(payload.sub);

    if (
      !user ||
      user.status === UserStatus.SUSPENDED ||
      user.status === UserStatus.DELETED
    ) {
      throw new UnauthorizedException("Invalid token");
    }

    // Un token de antes del último cambio de contraseña ya no vale (ver
    // session-revocation.ts). Se mira DESPUÉS de traer la cuenta porque la
    // fecha del cambio vive ahí, y esta consulta ya se hacía igual.
    if (emitidoAntesDelCambioDeClave(payload.iat, user.passwordChangedAt)) {
      throw sesionRevocada();
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      verificationStatus: user.verificationStatus,
      dateOfBirth: user.dateOfBirth,
      licenseExpiresAt: user.licenseExpiresAt,
      licenseClass: user.licenseClass,
      licenseBeginnerUntil: user.licenseBeginnerUntil,
      dniExpiresAt: user.dniExpiresAt,
      tokenScope: "onboarding" as const,
    };
  }
}
