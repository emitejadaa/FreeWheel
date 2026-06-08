import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  UserStatus,
  VerificationCodePurpose,
  VerificationStatus,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { GoogleProfilePayload } from "./strategies/google.strategy";
import { assertFound } from "../common/utils/entity.util";
import {
  consumeVerificationCode,
  generateNumericCode,
  generateOpaqueToken,
  VERIFICATION_CODE_TTL_MS,
} from "../common/utils/verification-code.util";

// Enumeration-safe reply: identical whether or not the email belongs to a user.
const PASSWORD_RESET_REPLY = "If that email exists, we sent you a link.";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async register(registerDto: RegisterDto) {
    const existing = await this.usersService.findByEmail(registerDto.email);
    if (existing) throw new ConflictException("Email already registered");

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
    this.logger.log(`User registered: ${user.email} (${user.id})`);

    const safeUser = this.usersService.toSafeUser(user);
    return {
      user: safeUser,
      accessToken: this.signToken(user.id, user.email),
      emailVerificationRequired: true,
    };
  }

  async login(loginDto: LoginDto) {
    const user = await this.usersService.findByEmail(loginDto.email);

    if (!user) {
      this.logger.warn(`Login failed (unknown email): ${loginDto.email}`);
      throw new UnauthorizedException("Invalid credentials");
    }

    if (
      user.status === UserStatus.SUSPENDED ||
      user.status === UserStatus.DELETED
    ) {
      this.logger.warn(`Login blocked (status ${user.status}): ${user.email}`);
      throw new UnauthorizedException("Account is not active");
    }

    const ok = await bcrypt.compare(loginDto.password, user.password);
    if (!ok) {
      this.logger.warn(`Login failed (bad password): ${user.email}`);
      throw new UnauthorizedException("Invalid credentials");
    }

    this.logger.log(`User logged in: ${user.email}`);
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

    const code = generateNumericCode();
    const codeHash = await bcrypt.hash(code, 10);

    await this.prisma.verificationCode.create({
      data: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_VERIFICATION,
        targetType: "EMAIL",
        targetValue: email,
        codeHash,
        expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
      },
    });

    await this.emailService.sendVerificationCode(email, code);
    return { message: "Verification code sent" };
  }

  async verifyEmail(userId: string, dto: VerifyEmailDto) {
    const user = await this.usersService.findById(userId);
    assertFound(user, "User not found");

    if (user.verificationStatus !== VerificationStatus.UNVERIFIED) {
      return { message: "Email already verified" };
    }

    await consumeVerificationCode(this.prisma, {
      where: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_VERIFICATION,
      },
      plaintext: dto.code,
      errors: {
        missing: () =>
          new BadRequestException("Code expired. Request a new one."),
        expired: () =>
          new BadRequestException("Code expired. Request a new one."),
        tooManyAttempts: () =>
          new BadRequestException("Too many attempts. Request a new code."),
        invalid: () => new BadRequestException("Incorrect code"),
      },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        verificationStatus: VerificationStatus.EMAIL_VERIFIED,
        emailVerifiedAt: new Date(),
      },
    });

    this.logger.log(`Email verified for user ${userId}`);
    return { message: "Email verified successfully" };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    this.logger.log(`Password reset requested for ${dto.email}`);

    const user = await this.usersService.findByEmail(dto.email);
    if (!user) return { message: PASSWORD_RESET_REPLY };

    await this.prisma.verificationCode.updateMany({
      where: {
        userId: user.id,
        purpose: VerificationCodePurpose.PASSWORD_RESET,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    const token = generateOpaqueToken(32);
    const tokenHash = await bcrypt.hash(token, 10);

    await this.prisma.verificationCode.create({
      data: {
        userId: user.id,
        purpose: VerificationCodePurpose.PASSWORD_RESET,
        targetType: "EMAIL",
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

    return { message: PASSWORD_RESET_REPLY };
  }

  async resetPassword(dto: ResetPasswordDto) {
    await consumeVerificationCode(this.prisma, {
      where: {
        userId: dto.userId,
        purpose: VerificationCodePurpose.PASSWORD_RESET,
      },
      plaintext: dto.token,
      errors: {
        missing: () =>
          new BadRequestException("This link has expired or is invalid."),
        expired: () =>
          new BadRequestException("This link has expired or is invalid."),
        tooManyAttempts: () =>
          new BadRequestException(
            "Invalid link. Request a new recovery email.",
          ),
        invalid: () => new BadRequestException("This link is invalid."),
      },
    });

    await this.prisma.user.update({
      where: { id: dto.userId },
      data: { password: await bcrypt.hash(dto.newPassword, 10) },
    });

    this.logger.log(`Password reset completed for user ${dto.userId}`);
    return { message: "Password updated successfully." };
  }

  async googleLogin(googleUser: GoogleProfilePayload) {
    let user = await this.usersService.findByEmail(googleUser.email);

    if (!user) {
      const randomPassword = await bcrypt.hash(generateOpaqueToken(32), 10);
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

    this.logger.log(`Google login for ${user.email}`);
    return {
      user: this.usersService.toSafeUser(user),
      accessToken: this.signToken(user.id, user.email),
    };
  }

  async requestEmailChange(userId: string, newEmail: string) {
    const existing = await this.usersService.findByEmail(newEmail);
    if (existing) throw new ConflictException("This email is already in use.");

    await this.prisma.verificationCode.updateMany({
      where: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_VERIFICATION,
        targetValue: newEmail,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    const code = generateNumericCode();
    const codeHash = await bcrypt.hash(code, 10);

    await this.prisma.verificationCode.create({
      data: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_VERIFICATION,
        targetType: "EMAIL",
        targetValue: newEmail,
        codeHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    await this.emailService.sendVerificationCode(newEmail, code);
    return { message: "Code sent to the new email." };
  }

  async confirmEmailChange(userId: string, code: string, newEmail: string) {
    const existing = await this.usersService.findByEmail(newEmail);
    if (existing) throw new ConflictException("This email is already in use.");

    await consumeVerificationCode(this.prisma, {
      where: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_VERIFICATION,
        targetValue: newEmail,
      },
      plaintext: code,
      errors: {
        missing: () =>
          new BadRequestException("Code expired. Request a new one."),
        expired: () =>
          new BadRequestException("Code expired. Request a new one."),
        tooManyAttempts: () =>
          new BadRequestException("Too many attempts. Request a new code."),
        invalid: () => new BadRequestException("Incorrect code"),
      },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { email: newEmail },
    });

    this.logger.log(`Email changed for user ${userId}`);
    return { message: "Email updated successfully." };
  }

  private signToken(userId: string, email: string) {
    return this.jwtService.sign({ email }, { subject: userId });
  }
}
