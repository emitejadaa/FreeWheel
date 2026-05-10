import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  UserStatus,
  VerificationCodePurpose,
  VerificationStatus,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async register(registerDto: RegisterDto) {
    const existing = await this.usersService.findByEmail(registerDto.email);
    if (existing) throw new ConflictException('Email already registered');

    const password = await bcrypt.hash(registerDto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        email: registerDto.email,
        password,
        firstName: registerDto.firstName,
        lastName: registerDto.lastName,
        displayName: registerDto.displayName,
        acceptedTermsAt: registerDto.acceptedTerms ? new Date() : null,
      },
    });

    await this.sendVerificationEmail(user.id, user.email);

    const safeUser = this.usersService.toSafeUser(user);
    return {
      user: safeUser,
      accessToken: this.signToken(user.id, user.email),
      emailVerificationRequired: true,
    };
  }

  async login(loginDto: LoginDto) {
    const user = await this.usersService.findByEmail(loginDto.email);

    if (!user) throw new UnauthorizedException('Invalid credentials');

    if (
      user.status === UserStatus.SUSPENDED ||
      user.status === UserStatus.DELETED
    ) {
      throw new UnauthorizedException('Account is not active');
    }

    const ok = await bcrypt.compare(loginDto.password, user.password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    return {
      user: this.usersService.toSafeUser(user),
      accessToken: this.signToken(user.id, user.email),
    };
  }

  async sendVerificationEmail(userId: string, email: string) {
    await this.prisma.verificationCode.updateMany({
      where: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_VERIFICATION,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(code, 10);

    await this.prisma.verificationCode.create({
      data: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_VERIFICATION,
        targetType: 'EMAIL',
        targetValue: email,
        codeHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    await this.emailService.sendVerificationCode(email, code);
    return { message: 'Verification code sent' };
  }

  async verifyEmail(userId: string, dto: VerifyEmailDto) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    if (user.verificationStatus !== VerificationStatus.UNVERIFIED) {
      return { message: 'Email already verified' };
    }

    const record = await this.prisma.verificationCode.findFirst({
      where: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_VERIFICATION,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new BadRequestException('Código expirado. Solicitá uno nuevo.');
    }
    if (record.attempts >= record.maxAttempts) {
      throw new BadRequestException(
        'Demasiados intentos. Solicitá un nuevo código.',
      );
    }

    const matches = await bcrypt.compare(dto.code, record.codeHash);
    if (!matches) {
      await this.prisma.verificationCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Código incorrecto');
    }

    await this.prisma.verificationCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        verificationStatus: VerificationStatus.EMAIL_VERIFIED,
        emailVerifiedAt: new Date(),
      },
    });

    return { message: 'Email verificado correctamente' };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) return { message: 'Si ese email existe, te enviamos un link.' };

    await this.prisma.verificationCode.updateMany({
      where: {
        userId: user.id,
        purpose: VerificationCodePurpose.PASSWORD_RESET,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(token, 10);

    await this.prisma.verificationCode.create({
      data: {
        userId: user.id,
        purpose: VerificationCodePurpose.PASSWORD_RESET,
        targetType: 'EMAIL',
        targetValue: user.email,
        codeHash: tokenHash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await this.emailService.sendPasswordReset(
      user.email,
      user.firstName,
      token,
      user.id,
    );

    return { message: 'Si ese email existe, te enviamos un link.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const record = await this.prisma.verificationCode.findFirst({
      where: {
        userId: dto.userId,
        purpose: VerificationCodePurpose.PASSWORD_RESET,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new BadRequestException('El link expiró o es inválido.');
    }
    if (record.attempts >= record.maxAttempts) {
      throw new BadRequestException(
        'Link inválido. Solicitá un nuevo email de recuperación.',
      );
    }

    const matches = await bcrypt.compare(dto.token, record.codeHash);
    if (!matches) {
      await this.prisma.verificationCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('El link es inválido.');
    }

    await this.prisma.verificationCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });

    await this.prisma.user.update({
      where: { id: dto.userId },
      data: { password: await bcrypt.hash(dto.newPassword, 10) },
    });

    return { message: 'Contraseña actualizada correctamente.' };
  }

  async googleLogin(googleUser: {
    email: string;
    firstName: string;
    lastName: string;
    googleId: string;
    profilePhotoUrl?: string | null;
  }) {
    let user = await this.usersService.findByEmail(googleUser.email);

    if (!user) {
      const randomPassword = await bcrypt.hash(
        crypto.randomBytes(32).toString('hex'),
        10,
      );
      user = await this.prisma.user.create({
        data: {
          email: googleUser.email,
          password: randomPassword,
          firstName: googleUser.firstName,
          lastName: googleUser.lastName,
          googleId: googleUser.googleId,
          profilePhotoUrl: googleUser.profilePhotoUrl ?? null,
          verificationStatus: VerificationStatus.EMAIL_VERIFIED,
          emailVerifiedAt: new Date(),
        },
      });
    } else if (!user.googleId) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: googleUser.googleId,
          verificationStatus:
            user.verificationStatus === VerificationStatus.UNVERIFIED
              ? VerificationStatus.EMAIL_VERIFIED
              : user.verificationStatus,
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        },
      });
    }

    return {
      user: this.usersService.toSafeUser(user),
      accessToken: this.signToken(user.id, user.email),
    };
  }

  private signToken(userId: string, email: string) {
    return this.jwtService.sign({ email }, { subject: userId });
  }
}