import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VerificationService } from './verification.service';

@Injectable()
export class CodeResendService {
  constructor(
    private prisma: PrismaService,
    private verificationService: VerificationService,
  ) {}

  private generateVerificationCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private getVerificationCodeExpiresAt(): Date {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 15);
    return now;
  }

  async resendEmailVerification(email: string) {
    const pendingUser = await this.prisma.pendingEmailVerification.findUnique({
      where: { email },
    });

    if (!pendingUser) {
      throw new BadRequestException('No hay registro pendiente de verificación para este email');
    }

    const verificationCode = this.generateVerificationCode();
    const expiresAt = this.getVerificationCodeExpiresAt();

    await this.prisma.pendingEmailVerification.update({
      where: { email },
      data: {
        verificationCode,
        expiresAt,
      },
    });

    await this.verificationService.sendEmailVerification(email, verificationCode);

    return {
      message: 'Código de verificación reenviado al email',
      email,
    };
  }

  async resendMobileVerification(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new BadRequestException('Usuario no encontrado');
    }

    if (!user.mobile) {
      throw new BadRequestException('No hay número de móvil registrado');
    }

    if (user.verifiedMobile) {
      throw new BadRequestException('Móvil ya verificado');
    }

    const verificationCode = this.generateVerificationCode();
    const expiresAt = this.getVerificationCodeExpiresAt();

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mobileVerificationCode: verificationCode,
        mobileVerificationCodeExpiresAt: expiresAt,
      },
    });

    await this.verificationService.sendMobileVerification(user.mobile, verificationCode);

    return {
      message: 'Código de verificación reenviado por SMS',
      mobile: user.mobile,
    };
  }
}
