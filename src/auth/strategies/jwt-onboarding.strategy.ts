import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { UserStatus } from "@prisma/client";
import { ExtractJwt, Strategy } from "passport-jwt";
import { UsersService } from "../../users/users.service";
import { getJwtSecret } from "../../config/jwt.config";

interface OnboardingJwtPayload {
  sub: string;
  email: string;
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

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      verificationStatus: user.verificationStatus,
      dateOfBirth: user.dateOfBirth,
      tokenScope: "onboarding" as const,
    };
  }
}
