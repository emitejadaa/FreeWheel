import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { SignOptions } from "jsonwebtoken";
import {
  UserStatus,
  VerificationCodePurpose,
  VerificationStatus,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { LoginDto } from "./dto/login.dto";
import { RegisterStartDto } from "./dto/register-start.dto";
import { RegisterCompleteDto } from "./dto/register-complete.dto";
import { CompleteProfileDto } from "./dto/complete-profile.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { IdentityReviewService } from "../verification/review/identity-review.service";
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
    private readonly identityReview: IdentityReviewService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Step 1 of registration: send a verification code to an email that has no
   * account yet. No User row exists until the code is confirmed in
   * registerComplete. Re-calling rotates the code (doubles as "resend").
   */
  async registerStart(dto: RegisterStartDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) throw new ConflictException("Email already registered");

    const code = generateNumericCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);

    await this.prisma.pendingRegistration.upsert({
      where: { email: dto.email },
      update: { codeHash, expiresAt, attempts: 0, consumedAt: null },
      create: { email: dto.email, codeHash, expiresAt },
    });

    await this.emailService.sendVerificationCode(dto.email, code);
    this.logger.log(`Registration code sent to ${dto.email}`);

    return { message: "Verification code sent", expiresAt };
  }

  /**
   * Step 2 of registration: the email code plus the full registration payload.
   * Only here is the User created — already email-verified — inside one
   * transaction that also deletes the pending registration.
   */
  async registerComplete(dto: RegisterCompleteDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) throw new ConflictException("Email already registered");

    await this.consumePendingRegistrationCode(dto.email, dto.code);

    const password = await bcrypt.hash(dto.password, 10);
    const now = new Date();

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email,
          password,
          firstName: dto.firstName,
          lastName: dto.lastName,
          displayName: dto.displayName,
          dateOfBirth: parseBirthDate(dto.dateOfBirth),
          acceptedTermsAt: now,
          status: UserStatus.ACTIVE,
          verificationStatus: VerificationStatus.EMAIL_VERIFIED,
          emailVerifiedAt: now,
        },
      });
      await tx.pendingRegistration.delete({ where: { email: dto.email } });
      return created;
    });

    this.logger.log(`User registered: ${user.email} (${user.id})`);

    return {
      user: this.usersService.toSafeUser(user),
      accessToken: this.signToken(user.id, user.email),
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

    // Legacy accounts created before email-first registration: no session until
    // the email is verified. A fresh code is sent and a short-lived onboarding
    // token (only valid on the onboarding endpoints) lets them finish.
    if (!user.emailVerifiedAt) {
      await this.sendVerificationEmail(user.id, user.email);
      this.logger.log(`Login pending email verification: ${user.email}`);
      return {
        user: this.usersService.toSafeUser(user),
        emailVerificationRequired: true,
        onboardingToken: this.signOnboardingToken(user.id, user.email),
      };
    }

    // Date of birth is mandatory for everyone (18+); legacy and Google accounts
    // without one must complete their profile before getting a full session.
    if (!user.dateOfBirth) {
      this.logger.log(`Login pending profile completion: ${user.email}`);
      return {
        user: this.usersService.toSafeUser(user),
        profileCompletionRequired: true,
        onboardingToken: this.signOnboardingToken(user.id, user.email),
      };
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

  /** Legacy-account email verification (new registrations verify pre-creation). */
  async verifyEmail(userId: string, dto: VerifyEmailDto) {
    let user = await this.usersService.findById(userId);
    assertFound(user, "User not found");

    if (!user.emailVerifiedAt) {
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

      user = await this.prisma.user.update({
        where: { id: userId },
        data: {
          emailVerifiedAt: new Date(),
          verificationStatus:
            user.verificationStatus === VerificationStatus.UNVERIFIED
              ? VerificationStatus.EMAIL_VERIFIED
              : user.verificationStatus,
        },
      });

      await this.identityReview.evaluate(userId);
      this.logger.log(`Email verified for user ${userId}`);
    }

    // Hand out the next step: a full session if the profile is complete, or an
    // onboarding token so the user can provide their date of birth.
    if (!user.dateOfBirth) {
      return {
        message: "Email verified successfully",
        profileCompletionRequired: true,
        onboardingToken: this.signOnboardingToken(user.id, user.email),
      };
    }

    return {
      message: "Email verified successfully",
      accessToken: this.signToken(user.id, user.email),
    };
  }

  /**
   * Completes the mandatory profile data (date of birth, 18+) for accounts
   * created without it (Google sign-in, legacy). Immutable once set.
   */
  async completeProfile(userId: string, dto: CompleteProfileDto) {
    let user = await this.usersService.findById(userId);
    assertFound(user, "User not found");

    if (!user.emailVerifiedAt) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "EMAIL_NOT_VERIFIED",
        message: "Verificá tu email antes de completar el perfil",
        emailVerificationRequired: true,
      });
    }

    if (!user.dateOfBirth) {
      user = await this.prisma.user.update({
        where: { id: userId },
        data: { dateOfBirth: parseBirthDate(dto.dateOfBirth) },
      });

      await this.identityReview.evaluate(userId);
      this.logger.log(`Profile completed (dateOfBirth) for user ${userId}`);
    }

    return {
      user: this.usersService.toSafeUser(user),
      accessToken: this.signToken(user.id, user.email),
    };
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

    // Google does not provide a birth date: until the user completes it (18+)
    // they only get an onboarding token, never a full session.
    if (!user.dateOfBirth) {
      return {
        user: this.usersService.toSafeUser(user),
        profileCompletionRequired: true as const,
        onboardingToken: this.signOnboardingToken(user.id, user.email),
      };
    }

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

  /**
   * Same find → expiry → attempts → compare sequence as consumeVerificationCode
   * (src/common/utils/verification-code.util.ts), but against the
   * PendingRegistration table, which has no userId. The row is not marked
   * consumed here — registerComplete deletes it in the user-creation
   * transaction, so a failure after this point still allows a retry.
   */
  private async consumePendingRegistrationCode(email: string, code: string) {
    const pending = await this.prisma.pendingRegistration.findUnique({
      where: { email },
    });

    if (!pending || pending.consumedAt) {
      throw new BadRequestException("Code expired. Request a new one.");
    }
    if (pending.expiresAt <= new Date()) {
      throw new BadRequestException("Code expired. Request a new one.");
    }
    if (pending.attempts >= pending.maxAttempts) {
      throw new BadRequestException("Too many attempts. Request a new code.");
    }

    const matches = await bcrypt.compare(code, pending.codeHash);
    if (!matches) {
      await this.prisma.pendingRegistration.update({
        where: { id: pending.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException("Incorrect code");
    }
  }

  private signToken(userId: string, email: string) {
    return this.jwtService.sign({ email }, { subject: userId });
  }

  /**
   * Short-lived token scoped to the onboarding endpoints only (JwtStrategy
   * rejects it everywhere else). Issued when a user still owes email
   * verification or their date of birth.
   */
  private signOnboardingToken(userId: string, email: string) {
    const expiresIn =
      this.configService.get<string>("ONBOARDING_JWT_EXPIRES_IN") ?? "30m";
    return this.jwtService.sign(
      { email, scope: "onboarding" },
      { subject: userId, expiresIn: expiresIn as SignOptions["expiresIn"] },
    );
  }
}

/** DTO-validated YYYY-MM-DD string → Date at UTC midnight. */
function parseBirthDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
