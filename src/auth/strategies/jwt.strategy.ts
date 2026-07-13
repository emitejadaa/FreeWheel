import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { UserStatus } from "@prisma/client";
import { ExtractJwt, Strategy } from "passport-jwt";
import { UsersService } from "../../users/users.service";
import { getJwtSecret } from "../../config/jwt.config";

interface JwtPayload {
  sub: string;
  email: string;
  /** Scoped tokens (e.g. "onboarding") are rejected by this strategy. */
  scope?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
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

  async validate(payload: JwtPayload) {
    // Fail closed: scoped tokens (onboarding) are only valid on the endpoints
    // that explicitly accept them via OnboardingAuthGuard / JwtOnboardingStrategy.
    // Return null (a passport "fail", not an "error") so that in the multi-strategy
    // OnboardingAuthGuard passport falls through to the onboarding strategy; a
    // standalone JwtAuthGuard still turns this into a 401.
    if (payload.scope !== undefined) {
      return null;
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
    };
  }
}
