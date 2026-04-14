import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VerificationService } from './verification.service';
import { TokenService } from './token.service';
import * as bcrypt from 'bcrypt'; 

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private verificationService: VerificationService,
    private tokenService: TokenService,
  ) {}

  // Generar código de verificación de 6 dígitos
  private generateVerificationCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  // Calcular expiration time (15 minutos)
  private getVerificationCodeExpiresAt(): Date {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 15);
    return now;
  }

  async register(email: string, password: string, firstName: string, lastName: string, birthDate: string) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new BadRequestException('Email ya registrado');
    }

    const existingPending = await this.prisma.pendingEmailVerification.findUnique({
      where: { email },
    });

    if (existingPending) {
      throw new BadRequestException('Email en proceso de verificación. Por favor, verifica tu email o intenta de nuevo más tarde');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationCode = this.generateVerificationCode();
    const expiresAt = this.getVerificationCodeExpiresAt();

    await this.prisma.pendingEmailVerification.create({
      data: {
        email,
        password: hashedPassword,
        firstName,
        lastName,
        birthDate: new Date(birthDate),
        verificationCode,
        expiresAt,
      },
    });

    await this.verificationService.sendEmailVerification(email, verificationCode);

    return {
      message: 'Cuenta pendiente de verificación. Revisa tu email para completar el registro.',
      email,
    };
  }

  async verifyEmail(email: string, verificationCode: string) {
    const pendingUser = await this.prisma.pendingEmailVerification.findUnique({
      where: { email },
    });

    if (!pendingUser) {
      throw new BadRequestException('No hay registro pendiente de verificación para este email');
    }

    if (pendingUser.verificationCode !== verificationCode) {
      throw new BadRequestException('Código de verificación incorrecto');
    }

    if (pendingUser.expiresAt < new Date()) {
      await this.prisma.pendingEmailVerification.delete({
        where: { email },
      });
      throw new BadRequestException('Código de verificación expirado. Por favor, registrate de nuevo');
    }

    const user = await this.prisma.user.create({
      data: {
        email: pendingUser.email,
        password: pendingUser.password,
        firstName: pendingUser.firstName,
        lastName: pendingUser.lastName,
        birthDate: pendingUser.birthDate,
        verifiedEmail: true,
      },
    });

    await this.prisma.pendingEmailVerification.delete({
      where: { email },
    });

    return {
      message: 'Email verificado. Tu cuenta ha sido creada exitosamente.',
      userId: user.id,
      email: user.email,
    };
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const accessToken = this.tokenService.generateAccessToken(user.id, user.email);
    const refreshToken = this.tokenService.generateRefreshToken(user.id);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        mobile: user.mobile,
        verifiedMobile: user.verifiedMobile,
      },
    };
  }

  async addMobile(userId: string, mobile: string) {
    // Verificar que el móvil no esté ya registrado
    const existingMobile = await this.prisma.user.findUnique({
      where: { mobile },
    });

    if (existingMobile) {
      throw new BadRequestException('Número de móvil ya registrado');
    }

    const verificationCode = this.generateVerificationCode();
    const expiresAt = this.getVerificationCodeExpiresAt();

    // Actualizar usuario con móvil y código de verificación
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        mobile,
        verifiedMobile: false,
        mobileVerificationCode: verificationCode,
        mobileVerificationCodeExpiresAt: expiresAt,
      },
    });

    // Enviar código de verificación por SMS
    await this.verificationService.sendMobileVerification(mobile, verificationCode);

    return {
      message: 'Número de móvil registrado. Revisa tu SMS para verificar el número.',
      userId: user.id,
      mobile: user.mobile,
    };
  }

  async verifyMobile(userId: string, verificationCode: string) {
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

    if (user.mobileVerificationCode !== verificationCode) {
      throw new BadRequestException('Código de verificación incorrecto');
    }

    if (user.mobileVerificationCodeExpiresAt && user.mobileVerificationCodeExpiresAt < new Date()) {
      throw new BadRequestException('Código de verificación expirado');
    }

    // Actualizar usuario para marcar móvil como verificado
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        verifiedMobile: true,
        mobileVerificationCode: null,
        mobileVerificationCodeExpiresAt: null,
      },
    });

    return {
      message: 'Móvil verificado exitosamente',
      userId: updatedUser.id,
      mobile: updatedUser.mobile,
    };
  }
}