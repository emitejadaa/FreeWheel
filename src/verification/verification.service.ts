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
import { UploadSignatureDto } from "./dto/upload-signature.dto";
import {
  IdentityDocumentsService,
  readReasonCodes,
} from "./identity/identity-documents.service";
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

/** Estado de la última revisión en términos que entiende el front. */
function describeOutcome(
  status: VerificationStatus | null,
): "approved" | "rejected" | "pending" | "none" {
  if (status === VerificationStatus.VERIFIED) return "approved";
  if (status === VerificationStatus.REJECTED) return "rejected";
  if (status === VerificationStatus.ID_SUBMITTED) return "pending";
  return "none";
}

@Injectable()
export class VerificationService {
  private readonly maxAttempts = 5;
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    private readonly identityDocuments: IdentityDocumentsService,
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
      // Motivos en códigos estables: el detalle de la extracción es PII y solo
      // lo ve un admin.
      lastReview: {
        outcome: describeOutcome(latestSubmission?.status ?? null),
        reasonCodes: readReasonCodes(latestSubmission?.matchReport),
      },
    };
  }

  /** Firma la subida de un documento de identidad (documento + lado). */
  signIdentityUpload(userId: string, data: UploadSignatureDto) {
    return this.identityDocuments.signUpload(userId, data);
  }

  async submitIdentity(userId: string, data: SubmitIdentityDto) {
    const user = await this.getUser(userId);

    // Cada URL debe ser nuestra, del slot correcto, de esta cuenta y existir:
    // se persiste la forma canónica sin firma.
    const documents = await this.identityDocuments.validateSubmission(
      userId,
      data,
    );

    const verification = await this.prisma.userVerification.create({
      data: {
        userId,
        ...documents,
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

    // Re-read: the review may have already resolved the submission.
    const reviewed = await this.prisma.userVerification.findUnique({
      where: { id: verification.id },
    });
    assertFound(reviewed, "Verification not found");

    return this.identityDocuments.toPublicView(reviewed);
  }

  /**
   * Vuelve a correr la revisión de la última submission pendiente (p. ej.
   * tras un timeout del proveedor o después de corregir los datos del perfil).
   */
  async retryIdentityReview(userId: string) {
    const submission = await this.latestSubmission(userId);
    if (!submission) {
      throw new NotFoundException("No hay documentos enviados para revisar");
    }
    if (submission.status !== VerificationStatus.ID_SUBMITTED) {
      throw new BadRequestException({
        statusCode: 400,
        code: "REVIEW_NOT_PENDING",
        message: "La última solicitud ya tiene un veredicto",
      });
    }

    await this.identityReview.evaluate(userId);

    return this.getMyStatus(userId);
  }

  async getMyIdentity(userId: string) {
    const submissions = await this.prisma.userVerification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    return submissions.map((submission) =>
      this.identityDocuments.toPublicView(submission),
    );
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
