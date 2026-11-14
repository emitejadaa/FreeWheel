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

interface JwtPayload {
  sub: string;
  email: string;
  /** Cuándo se firmó, en segundos. Lo pone jsonwebtoken al firmar. */
  iat?: number;
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
      // - [Sesiones 1] El token se saca del header Authorization: Bearer
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // - [Sesiones 2] Se verifica la firma con la clave secreta. Si alguien tocó el token, no pasa
      secretOrKey: getJwtSecret(configService),
      // Solo el algoritmo con el que firmamos: sin esto passport-jwt acepta
      // el que diga la cabecera del propio token (ver JWT_ALGORITHM).
      algorithms: [JWT_ALGORITHM],
    });
  }

  // - [Sesiones 3] Corre en cada pedido a una ruta protegida, después de que la firma dio bien
  async validate(payload: JwtPayload) {
    // Fail closed: scoped tokens (onboarding) are only valid on the endpoints
    // that explicitly accept them via OnboardingAuthGuard / JwtOnboardingStrategy.
    // Return null (a passport "fail", not an "error") so that in the multi-strategy
    // OnboardingAuthGuard passport falls through to the onboarding strategy; a
    // standalone JwtAuthGuard still turns this into a 401.
    if (payload.scope !== undefined) {
      return null;
    }

    // - [Sesiones 4] Busca al usuario con el id que trae el token
    const user = await this.usersService.findById(payload.sub);

    if (
      !user ||
      // - [Sesiones 5] Cuenta suspendida o borrada: el token deja de valer
      user.status === UserStatus.SUSPENDED ||
      user.status === UserStatus.DELETED
    ) {
      throw new UnauthorizedException("Invalid token");
    }

    // Un token de antes del último cambio de contraseña ya no vale (ver
    // session-revocation.ts). Se mira DESPUÉS de traer la cuenta porque la
    // fecha del cambio vive ahí, y esta consulta ya se hacía igual.
    // - [Sesiones 6] Token de antes del último cambio de contraseña: tampoco vale
    if (emitidoAntesDelCambioDeClave(payload.iat, user.passwordChangedAt)) {
      throw sesionRevocada();
    }

    // - [Sesiones 7] Devuelve el usuario con su rol, que después usa el guard de roles
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
    };
  }
}
