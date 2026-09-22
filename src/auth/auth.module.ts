import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import type { SignOptions } from "jsonwebtoken";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { JwtOnboardingStrategy } from "./strategies/jwt-onboarding.strategy";
import { GoogleStrategy } from "./strategies/google.strategy";
import { UsersModule } from "../users/users.module";
import { PrismaModule } from "../prisma/prisma.module";
import { EmailModule } from "../email/email.module";
import { VerificationModule } from "../verification/verification.module";
import { getJwtSecret, JWT_ALGORITHM } from "../config/jwt.config";

const googleStrategyProviders =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? [GoogleStrategy]
    : [];

@Module({
  imports: [
    UsersModule,
    PrismaModule,
    EmailModule,
    VerificationModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const expiresIn = configService.get<string>("JWT_EXPIRES_IN") ?? "7d";

        return {
          secret: getJwtSecret(configService),
          // El algoritmo se fija de los dos lados (ver JWT_ALGORITHM): los
          // strategies de passport lo fijan al verificar, y esto al firmar y
          // en cualquier `jwtService.verify` que se agregue más adelante.
          signOptions: {
            expiresIn: expiresIn as SignOptions["expiresIn"],
            algorithm: JWT_ALGORITHM,
          },
          verifyOptions: { algorithms: [JWT_ALGORITHM] },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtOnboardingStrategy,
    ...googleStrategyProviders,
  ],
  exports: [AuthService],
})
export class AuthModule {}
