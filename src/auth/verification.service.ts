import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../notifications/email.service';
import { SmsService } from '../notifications/sms.service';

@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
  ) {}

  async issueEmailVerification(userId: string, email: string) {
    const cooldownSeconds = this.getNumberEnv(
      'EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS',
      60,
    );
    const latestToken = await this.prisma.emailVerificationToken.findFirst({
      where: {
        userId,
        usedAt: null,
        invalidatedAt: null,
      },
      orderBy: { sentAt: 'desc' },
    });

    if (latestToken && this.isCooldownActive(latestToken.sentAt, cooldownSeconds)) {
      throw new HttpException(
        'Espera unos segundos antes de volver a solicitar la verificación.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const rawCode = this.generateOtp();
    const tokenHash = this.hashValue(rawCode);
    const expiresAt = this.addMinutes(
      new Date(),
      this.getNumberEnv('EMAIL_VERIFICATION_TOKEN_TTL_MINUTES', 60),
    );

    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.updateMany({
        where: {
          userId,
          usedAt: null,
          invalidatedAt: null,
        },
        data: {
          invalidatedAt: new Date(),
        },
      }),
      this.prisma.emailVerificationToken.create({
        data: {
          userId,
          tokenHash,
          expiresAt,
        },
      }),
    ]);

    await this.emailService.sendAccountVerificationEmail({
      to: email,
      code: rawCode,
      expiresAt,
    });
  }

  async consumeEmailVerificationToken(code: string) {
    const tokenHash = this.hashValue(code);
    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (
      !record ||
      record.usedAt ||
      record.invalidatedAt ||
      record.expiresAt < new Date()
    ) {
      throw new BadRequestException('Código de verificación inválido o expirado.');
    }

    const now = new Date();
    const [, user] = await this.prisma.$transaction([
      this.prisma.emailVerificationToken.update({
        where: { id: record.id },
        data: {
          usedAt: now,
        },
      }),
      this.prisma.user.update({
        where: { id: record.userId },
        data: {
          emailVerified: true,
          emailVerifiedAt: now,
        },
      }),
      this.prisma.emailVerificationToken.updateMany({
        where: {
          userId: record.userId,
          id: { not: record.id },
          usedAt: null,
          invalidatedAt: null,
        },
        data: {
          invalidatedAt: now,
        },
      }),
    ]);

    return user;
  }

  async resendEmailVerification(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        emailVerified: true,
      },
    });

    if (!user || user.emailVerified) {
      return;
    }

    const latestToken = await this.prisma.emailVerificationToken.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        invalidatedAt: null,
      },
      orderBy: { sentAt: 'desc' },
    });

    const cooldownSeconds = this.getNumberEnv(
      'EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS',
      60,
    );

    if (latestToken && this.isCooldownActive(latestToken.sentAt, cooldownSeconds)) {
      return;
    }

    await this.issueEmailVerification(user.id, user.email);
  }

  async sendPhoneVerificationCode(userId: string) {
    const user = await this.getUserForPhoneVerification(userId);

    if (user.phoneVerified) {
      throw new BadRequestException('El teléfono ya está verificado.');
    }

    const cooldownSeconds = this.getNumberEnv(
      'PHONE_VERIFICATION_RESEND_COOLDOWN_SECONDS',
      60,
    );
    const latestCode = await this.prisma.phoneVerificationCode.findFirst({
      where: {
        userId,
        phoneNumber: user.phoneNumber,
        usedAt: null,
        invalidatedAt: null,
      },
      orderBy: { sentAt: 'desc' },
    });

    if (latestCode && this.isCooldownActive(latestCode.sentAt, cooldownSeconds)) {
      throw new HttpException(
        'Espera unos segundos antes de volver a solicitar un código.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const rawCode = this.generateOtp();
    const expiresAt = this.addMinutes(
      new Date(),
      this.getNumberEnv('PHONE_VERIFICATION_OTP_TTL_MINUTES', 10),
    );

    await this.prisma.$transaction([
      this.prisma.phoneVerificationCode.updateMany({
        where: {
          userId,
          phoneNumber: user.phoneNumber,
          usedAt: null,
          invalidatedAt: null,
        },
        data: {
          invalidatedAt: new Date(),
        },
      }),
      this.prisma.phoneVerificationCode.create({
        data: {
          userId,
          phoneNumber: user.phoneNumber,
          codeHash: this.hashValue(rawCode),
          expiresAt,
        },
      }),
    ]);

    await this.smsService.sendPhoneVerificationCode({
      to: user.phoneNumber,
      code: rawCode,
      expiresAt,
    });
  }

  async verifyPhoneCode(userId: string, code: string) {
    const user = await this.getUserForPhoneVerification(userId);

    if (user.phoneVerified) {
      throw new BadRequestException('El teléfono ya está verificado.');
    }

    const verificationCode = await this.prisma.phoneVerificationCode.findFirst({
      where: {
        userId,
        phoneNumber: user.phoneNumber,
        usedAt: null,
        invalidatedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!verificationCode) {
      throw new BadRequestException(
        'No hay un código activo para verificar este teléfono.',
      );
    }

    if (verificationCode.expiresAt < new Date()) {
      await this.prisma.phoneVerificationCode.update({
        where: { id: verificationCode.id },
        data: {
          invalidatedAt: new Date(),
        },
      });

      throw new BadRequestException('El código de verificación expiró.');
    }

    const providedHash = this.hashValue(code);
    const maxAttempts = this.getNumberEnv('PHONE_VERIFICATION_MAX_ATTEMPTS', 5);
    const nextAttempts = verificationCode.attempts + 1;

    if (verificationCode.codeHash !== providedHash) {
      await this.prisma.phoneVerificationCode.update({
        where: { id: verificationCode.id },
        data: {
          attempts: nextAttempts,
          lastAttemptAt: new Date(),
          invalidatedAt: nextAttempts >= maxAttempts ? new Date() : null,
        },
      });

      throw new BadRequestException('Código de verificación inválido.');
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.phoneVerificationCode.update({
        where: { id: verificationCode.id },
        data: {
          usedAt: now,
          attempts: nextAttempts,
          lastAttemptAt: now,
        },
      }),
      this.prisma.phoneVerificationCode.updateMany({
        where: {
          userId,
          phoneNumber: user.phoneNumber,
          id: { not: verificationCode.id },
          usedAt: null,
          invalidatedAt: null,
        },
        data: {
          invalidatedAt: now,
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          phoneVerified: true,
          phoneVerifiedAt: now,
        },
      }),
    ]);
  }

  async invalidatePhoneVerifications(userId: string) {
    await this.prisma.phoneVerificationCode.updateMany({
      where: {
        userId,
        usedAt: null,
        invalidatedAt: null,
      },
      data: {
        invalidatedAt: new Date(),
      },
    });
  }

  private async getUserForPhoneVerification(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phoneNumber: true,
        phoneVerified: true,
      },
    });

    if (!user) {
      throw new BadRequestException('Usuario no encontrado.');
    }

    if (!user.phoneNumber) {
      throw new BadRequestException('Primero debes registrar un teléfono.');
    }

    return {
      id: user.id,
      phoneNumber: user.phoneNumber,
      phoneVerified: user.phoneVerified,
    } as {
      id: string;
      phoneNumber: string;
      phoneVerified: boolean;
    };
  }

  private hashValue(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private generateOtp() {
    return randomInt(100000, 1000000).toString();
  }

  private addMinutes(date: Date, minutes: number) {
    const next = new Date(date);
    next.setMinutes(next.getMinutes() + minutes);
    return next;
  }

  private isCooldownActive(sentAt: Date, cooldownSeconds: number) {
    return sentAt.getTime() + cooldownSeconds * 1000 > Date.now();
  }

  private getNumberEnv(name: string, fallback: number) {
    const rawValue = process.env[name];
    if (!rawValue) {
      return fallback;
    }

    const value = Number(rawValue);
    return Number.isNaN(value) ? fallback : value;
  }
}
