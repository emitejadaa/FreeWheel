import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  User,
  VerificationCodeTargetType,
  VerificationStatus,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { randomInt } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SubmitIdentityDto } from "./dto/submit-identity.dto";

type SafeVerificationResponse = {
  requested: true;
  expiresAt: Date;
  code?: string;
};

@Injectable()
export class VerificationService {
  private readonly codeTtlMs = 10 * 60 * 1000;
  private readonly maxAttempts = 5;

  constructor(private readonly prisma: PrismaService) {}

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

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        emailVerifiedAt: new Date(),
        verificationStatus: await this.resolveNextStatus(userId, {
          emailVerified: true,
        }),
      },
    });

    return this.toStatusResponse(user);
  }

  async confirmPhoneCode(userId: string, code: string) {
    await this.confirmCode(userId, VerificationCodeTargetType.PHONE, code);

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneVerifiedAt: new Date(),
        verificationStatus: await this.resolveNextStatus(userId, {
          phoneVerified: true,
        }),
      },
    });

    return this.toStatusResponse(user);
  }

  async getMyStatus(userId: string) {
    const user = await this.getUser(userId);

    return this.toStatusResponse(user);
  }

  async submitIdentity(userId: string, data: SubmitIdentityDto) {
    await this.getUser(userId);

    const verification = await this.prisma.userVerification.create({
      data: {
        userId,
        documentUrl: data.documentUrl,
        selfieUrl: data.selfieUrl,
        notes: data.notes,
        status: VerificationStatus.ID_SUBMITTED,
      },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { verificationStatus: VerificationStatus.ID_SUBMITTED },
    });

    return verification;
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
    const code = randomInt(100000, 999999).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + this.codeTtlMs);

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

    return {
      requested: true,
      expiresAt,
      ...(process.env.NODE_ENV !== "production" ? { code } : {}),
    };
  }

  private async confirmCode(
    userId: string,
    targetType: VerificationCodeTargetType,
    code: string,
  ) {
    const verificationCode = await this.prisma.verificationCode.findFirst({
      where: {
        userId,
        targetType,
        consumedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!verificationCode) {
      throw new NotFoundException("Verification code not found");
    }

    if (verificationCode.expiresAt <= new Date()) {
      throw new BadRequestException("Verification code expired");
    }

    if (verificationCode.attempts >= verificationCode.maxAttempts) {
      throw new ForbiddenException("Verification code attempts exceeded");
    }

    const matches = await bcrypt.compare(code, verificationCode.codeHash);

    if (!matches) {
      await this.prisma.verificationCode.update({
        where: { id: verificationCode.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException("Invalid verification code");
    }

    await this.prisma.verificationCode.update({
      where: { id: verificationCode.id },
      data: { consumedAt: new Date() },
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

  private toStatusResponse(user: User) {
    return {
      emailVerifiedAt: user.emailVerifiedAt,
      phoneVerifiedAt: user.phoneVerifiedAt,
      verificationStatus: user.verificationStatus,
    };
  }

  private async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    return user;
  }
}
