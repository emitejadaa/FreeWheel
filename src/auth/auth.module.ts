import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { VerificationService } from './verification.service';
import { TokenService } from './token.service';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AccountVerificationGuard } from './guards/account-verification.guard';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    NotificationsModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET', 'change-me'),
        signOptions: {
          expiresIn: configService.get<string>(
            'JWT_ACCESS_TOKEN_TTL',
            '15m',
          ) as any,
        },
      }),
    }),
  ],
  providers: [
    AuthService,
    VerificationService,
    TokenService,
    JwtStrategy,
    JwtAuthGuard,
    AccountVerificationGuard,
  ],
  controllers: [AuthController],
  exports: [
    AuthService,
    VerificationService,
    TokenService,
    JwtAuthGuard,
    AccountVerificationGuard,
  ],
})
export class AuthModule {}
