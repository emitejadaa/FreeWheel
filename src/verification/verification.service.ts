import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  User,
  VerificationCodeTargetType,
  VerificationStatus,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { SmsService } from "../sms/sms.service";
import { assertFound } from "../common/utils/entity.util";
import { SubmitIdentityDto } from "./dto/submit-identity.dto";
import {
  buildVerificationChecklist,
  IdentityReviewService,
} from "./review/identity-review.service";
import {
  consumeVerificationCode,
  generateNumericCode,
  VERIFICATION_CODE_TTL_MS,
} from "../common/utils/verification-code.util";

type SafeVerificationResponse = {
  requested: true;
  expiresAt: Date;
};

@Injectable()
export class VerificationService {
  private readonly maxAttempts = 5;
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    private readonly identityReview: IdentityReviewService,
  ) {}

  async requestEmailCode(userId: string): Promise<SafeVerificationResponse> {
    const user = await this.getUser(userId);

    return this.createCode(user, VerificationCodeTargetType.EMAIL, user.email);
  }

  async requestPhoneCode(userId: string): Promise<SafeVerificationResponse> {
    const user = await this.getUser(userId);

    if (!user.phone) {
      throw new BadRequestException(
        "User phone is required before verification",
      );
    }

    return this.createCode(user, VerificationCodeTargetType.PHONE, user.phone);
  }

  async confirmEmailCode(userId: string, code: string) {
    await this.confirmCode(userId, VerificationCodeTargetType.EMAIL, code);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        emailVerifiedAt: new Date(),
        verificationStatus: await this.resolveNextStatus(userId, {
          emailVerified: true,
        }),
      },
    });

    await this.identityReview.evaluate(userId);

    return this.getMyStatus(userId);
  }

  async confirmPhoneCode(userId: string, code: string) {
    await this.confirmCode(userId, VerificationCodeTargetType.PHONE, code);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneVerifiedAt: new Date(),
        verificationStatus: await this.resolveNextStatus(userId, {
          phoneVerified: true,
        }),
      },
    });

    await this.identityReview.evaluate(userId);

    return this.getMyStatus(userId);
  }

  /**
   * Derived checklist for the UI: the enum is a coarse milestone marker, but
   * phone/documents/date-of-birth complete independently and in any order.
   */
  async getMyStatus(userId: string) {
    const user = await this.getUser(userId);
    const latestSubmission = await this.latestSubmission(userId);
    const checklist = buildVerificationChecklist(user, latestSubmission);

    return {
      verificationStatus: user.verificationStatus,
      fullyVerified: user.verificationStatus === VerificationStatus.VERIFIED,
      checklist,
      emailVerifiedAt: user.emailVerifiedAt,
      phoneVerifiedAt: user.phoneVerifiedAt,
    };
  }

  async submitIdentity(userId: string, data: SubmitIdentityDto) {
    const user = await this.getUser(userId);

    const verification = await this.prisma.userVerification.create({
      data: {
        userId,
        dniFrontUrl: data.dniFrontUrl,
        dniBackUrl: data.dniBackUrl,
        licenseFrontUrl: data.licenseFrontUrl,
        licenseBackUrl: data.licenseBackUrl,
        selfieUrl: data.selfieUrl,
        notes: data.notes,
        status: VerificationStatus.ID_SUBMITTED,
      },
    });

    if (user.verificationStatus !== VerificationStatus.VERIFIED) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { verificationStatus: VerificationStatus.ID_SUBMITTED },
      });
    }

    await this.identityReview.evaluate(userId);

    // Re-read: the review may have already resolved the submission (auto-approve).
    return this.prisma.userVerification.findUnique({
      where: { id: verification.id },
    });
  }

  async getMyIdentity(userId: string) {
    return this.prisma.userVerification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  private async createCode(
    user: User,
    targetType: VerificationCodeTargetType,
    targetValue: string,
  ): Promise<SafeVerificationResponse> {
    const code = generateNumericCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);

    await this.prisma.verificationCode.updateMany({
      where: {
        userId: user.id,
        targetType,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    await this.prisma.verificationCode.create({
      data: {
        userId: user.id,
        targetType,
        targetValue,
        codeHash,
        expiresAt,
        maxAttempts: this.maxAttempts,
      },
    });

    // Deliver through the channel-appropriate provider. The SMS provider is a
    // logging mock until a real gateway is configured (SMS_PROVIDER env var).
    if (targetType === VerificationCodeTargetType.PHONE) {
      await this.smsService.sendVerificationCode(targetValue, code);
    } else {
      await this.emailService.sendVerificationCode(targetValue, code);
    }

    // In non-production, log the code so it can be used for manual testing. It is
    // never returned in the HTTP response and never logged in production, so it
    // cannot leak to clients.
    if (process.env.NODE_ENV !== "production") {
      this.logger.debug(
        `Verification code for ${targetType} ${targetValue}: ${code}`,
      );
    }

    return { requested: true, expiresAt };
  }

  private async confirmCode(
    userId: string,
    targetType: VerificationCodeTargetType,
    code: string,
  ) {
    await consumeVerificationCode(this.prisma, {
      where: { userId, targetType },
      plaintext: code,
      errors: {
        missing: () => new NotFoundException("Verification code not found"),
        expired: () => new BadRequestException("Verification code expired"),
        tooManyAttempts: () =>
          new ForbiddenException("Verification code attempts exceeded"),
        invalid: () => new BadRequestException("Invalid verification code"),
      },
    });
  }

  private async resolveNextStatus(
    userId: string,
    overrides: { emailVerified?: boolean; phoneVerified?: boolean } = {},
  ) {
    const user = await this.getUser(userId);
    const emailVerified =
      overrides.emailVerified ?? Boolean(user.emailVerifiedAt);
    const phoneVerified =
      overrides.phoneVerified ?? Boolean(user.phoneVerifiedAt);

    if (user.verificationStatus === VerificationStatus.VERIFIED) {
      return VerificationStatus.VERIFIED;
    }

    if (user.verificationStatus === VerificationStatus.ID_SUBMITTED) {
      return VerificationStatus.ID_SUBMITTED;
    }

    if (user.verificationStatus === VerificationStatus.REJECTED) {
      return VerificationStatus.REJECTED;
    }

    if (emailVerified && phoneVerified) {
      return VerificationStatus.PHONE_VERIFIED;
    }

    if (emailVerified) {
      return VerificationStatus.EMAIL_VERIFIED;
    }

    if (phoneVerified) {
      return VerificationStatus.PHONE_VERIFIED;
    }

    return VerificationStatus.UNVERIFIED;
  }

  private latestSubmission(userId: string) {
    return this.prisma.userVerification.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  private async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    assertFound(user, "User not found");

    return user;
  }
}
