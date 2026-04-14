import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { VerificationService } from './verification.service';
import { TokenService } from './token.service';
import { CodeResendService } from './code-resend.service';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'freewheel-secret-key-change-in-production',
      signOptions: { expiresIn: '24h' },
    }),
  ],
  providers: [AuthService, VerificationService, TokenService, JwtStrategy, JwtAuthGuard, CodeResendService],
  controllers: [AuthController],
  exports: [AuthService, VerificationService, TokenService, JwtAuthGuard],
})
export class AuthModule {}