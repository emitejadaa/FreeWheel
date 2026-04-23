import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VerificationService } from './verification.service';
import { TokenService } from './token.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LogoutDto } from './dto/logout.dto';
import { User } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verificationService: VerificationService,
    private readonly tokenService: TokenService,
  ) {}

  async register(registerDto: RegisterDto) {
    const email = this.normalizeEmail(registerDto.email);
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      throw new BadRequestException('El email ya está registrado.');
    }

    const passwordHash = await this.hashPassword(registerDto.password);
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName: registerDto.firstName.trim(),
        lastName: registerDto.lastName.trim(),
        birthDate: new Date(registerDto.birthDate),
      },
    });

    await this.verificationService.issueEmailVerification(user.id, user.email);

    return {
      message:
        'Cuenta creada correctamente. Revisa tu email para verificar la cuenta.',
      data: {
        user: this.buildProfileSummary(user),
      },
    };
  }

  async verifyEmail(token: string) {
    const user = await this.verificationService.consumeEmailVerificationToken(
      token,
    );

    return {
      message: 'Email verificado correctamente.',
      data: {
        user: this.buildProfileSummary(user),
      },
    };
  }

  async resendEmailVerification(email: string) {
    await this.verificationService.resendEmailVerification(
      this.normalizeEmail(email),
    );

    return {
      message:
        'Si el email corresponde a una cuenta pendiente, enviamos una nueva verificación.',
    };
  }

  async login(loginDto: LoginDto) {
    const email = this.normalizeEmail(loginDto.email);
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas.');
    }

    const validPassword = await bcrypt.compare(
      loginDto.password,
      user.passwordHash,
    );

    if (!validPassword) {
      throw new UnauthorizedException('Credenciales inválidas.');
    }

    const session = await this.issueSession(user);

    return {
      message: 'Login exitoso.',
      data: session,
    };
  }

  async refreshTokens(refreshTokenDto: RefreshTokenDto) {
    const user = await this.tokenService.rotateRefreshToken(
      refreshTokenDto.refreshToken,
    );

    const session = await this.issueSession(user, refreshTokenDto.refreshToken);
    return {
      message: 'Tokens renovados correctamente.',
      data: session,
    };
  }

  async logout(logoutDto: LogoutDto) {
    await this.tokenService.revokeRefreshToken(logoutDto.refreshToken);

    return {
      message: 'Sesión cerrada correctamente.',
    };
  }

  private async issueSession(user: User, previousRefreshToken?: string) {
    const accessToken = this.tokenService.generateAccessToken(user);
    const refreshToken = await this.tokenService.createRefreshToken(
      user.id,
      previousRefreshToken,
    );

    return {
      accessToken,
      refreshToken,
      user: this.buildProfileSummary(user),
    };
  }

  private async hashPassword(password: string) {
    const saltRounds = Number(process.env.PASSWORD_SALT_ROUNDS ?? '12');
    return bcrypt.hash(password, saltRounds);
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private buildProfileSummary(user: Pick<
    User,
    | 'id'
    | 'email'
    | 'emailVerified'
    | 'phoneNumber'
    | 'phoneVerified'
    | 'identityVerificationStatus'
  >) {
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      phoneNumber: user.phoneNumber,
      phoneVerified: user.phoneVerified,
      identityVerificationStatus: user.identityVerificationStatus,
      isFullyVerified: user.identityVerificationStatus === 'VERIFIED',
    };
  }
}
