import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import type { SignOptions } from "jsonwebtoken";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { GoogleStrategy } from "./strategies/google.strategy";
import { UsersModule } from "../users/users.module";
import { PrismaModule } from "../prisma/prisma.module";
import { EmailModule } from "../email/email.module";

const googleStrategyProviders =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? [GoogleStrategy]
    : [];

@Module({
  imports: [
    UsersModule,
    PrismaModule,
    EmailModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const expiresIn = configService.get<string>("JWT_EXPIRES_IN") ?? "7d";

        return {
          secret:
            configService.get<string>("JWT_SECRET") ??
            "freewheel-secret-key-change-in-production",
          signOptions: {
            expiresIn: expiresIn as SignOptions["expiresIn"],
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, ...googleStrategyProviders],
  exports: [AuthService],
})
export class AuthModule {}
