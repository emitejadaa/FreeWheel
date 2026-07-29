import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { User, UserVerification, VerificationStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { IDENTITY_REVIEWER } from "./identity-reviewer.interface";
import type { IdentityReviewer } from "./identity-reviewer.interface";

/** True when a submission carries all four required document photos. */
export function hasCompleteDocuments(
  submission: UserVerification | null,
): submission is UserVerification & {
  dniFrontUrl: string;
  dniBackUrl: string;
  licenseFrontUrl: string;
  licenseBackUrl: string;
} {
  return Boolean(
    submission &&
    submission.dniFrontUrl &&
    submission.dniBackUrl &&
    submission.licenseFrontUrl &&
    submission.licenseBackUrl,
  );
}

export interface VerificationChecklist {
  emailVerified: boolean;
  phoneVerified: boolean;
  documentsSubmitted: boolean;
  dateOfBirthProvided: boolean;
}

/**
 * ¿El teléfono confirmado es obligatorio para que la cuenta quede verificada?
 *
 * Se controla con REQUIRE_PHONE_VERIFICATION y por defecto es NO. Motivo: mandar
 * un SMS a un número real es un servicio pago, así que exigirlo dejaba a todas
 * las cuentas sin poder publicar ni reservar. El teléfono se sigue pudiendo
 * verificar (el código llega por email) y queda registrado, pero no bloquea.
 */
export function isPhoneVerificationRequired(config: {
  get: <T>(key: string) => T | undefined;
}): boolean {
  return (
    (
      config.get<string>("REQUIRE_PHONE_VERIFICATION") ?? "false"
    ).toLowerCase() === "true"
  );
}

/**
 * The single derived source of truth for "what is still missing". The
 * VerificationStatus enum stays a coarse milestone marker because it is
 * single-valued while these items complete independently and in any order.
 */
export function buildVerificationChecklist(
  user: User,
  latestSubmission: UserVerification | null,
): VerificationChecklist {
  return {
    emailVerified: Boolean(user.emailVerifiedAt),
    phoneVerified: Boolean(user.phoneVerifiedAt),
    // A submission rejected by an admin does not count: the user must resubmit.
    documentsSubmitted:
      hasCompleteDocuments(latestSubmission) &&
      latestSubmission.status !== VerificationStatus.REJECTED,
    dateOfBirthProvided: Boolean(user.dateOfBirth),
  };
}

/**
 * Runs after every verification event (email confirm, phone confirm, identity
 * submit, complete-profile): when the whole checklist is complete, the
 * configured reviewer decides and, on approval, the account becomes VERIFIED.
 * Callers never know which review mode is active.
 */
@Injectable()
export class IdentityReviewService {
  private readonly logger = new Logger(IdentityReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDENTITY_REVIEWER) private readonly reviewer: IdentityReviewer,
    private readonly config: ConfigService,
  ) {}

  /** Returns true when this call approved the account. */
  async evaluate(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.verificationStatus === VerificationStatus.VERIFIED) {
      return false;
    }

    const submission = await this.prisma.userVerification.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    // Only a submission still awaiting review may be auto-decided; VERIFIED or
    // REJECTED ones already carry an explicit (possibly admin) verdict.
    if (
      !hasCompleteDocuments(submission) ||
      submission.status !== VerificationStatus.ID_SUBMITTED
    ) {
      return false;
    }

    const checklist = buildVerificationChecklist(user, submission);
    const phonePending =
      isPhoneVerificationRequired(this.config) && !checklist.phoneVerified;

    if (
      !checklist.emailVerified ||
      phonePending ||
      !checklist.dateOfBirthProvided
    ) {
      return false;
    }

    const verdict = await this.reviewer.review({
      userId,
      verificationId: submission.id,
      dniFrontUrl: submission.dniFrontUrl,
      dniBackUrl: submission.dniBackUrl,
      licenseFrontUrl: submission.licenseFrontUrl,
      licenseBackUrl: submission.licenseBackUrl,
      selfieUrl: submission.selfieUrl,
    });

    // Datos leídos del documento: se guardan siempre, aprobado o rechazado.
    const extractedData = {
      ...(verdict.extracted?.documentNumber
        ? { documentNumber: verdict.extracted.documentNumber }
        : {}),
      ...(verdict.extracted?.fullName
        ? { fullNameOnDocument: verdict.extracted.fullName }
        : {}),
      ...(verdict.extracted?.licenseExpiresAt
        ? {
            licenseExpiresAt: new Date(
              `${verdict.extracted.licenseExpiresAt}T00:00:00.000Z`,
            ),
          }
        : {}),
    };

    // Sin decisión (modo manual): la solicitud queda como estaba, esperando que
    // un admin la revise. No es un rechazo.
    if (!verdict.approved && verdict.pending) {
      return false;
    }

    // Rechazo: queda asentado con el motivo para que la persona pueda corregir
    // las fotos y volver a enviarlas.
    if (!verdict.approved) {
      await this.prisma.userVerification.update({
        where: { id: submission.id },
        data: {
          status: VerificationStatus.REJECTED,
          reviewedAt: new Date(),
          reviewedBy: this.reviewer.name,
          notes: verdict.notes,
          ...extractedData,
        },
      });
      this.logger.log(
        `Identity submission ${submission.id} rejected (reviewer: ${this.reviewer.name})`,
      );
      return false;
    }

    await this.prisma.$transaction([
      this.prisma.userVerification.update({
        where: { id: submission.id },
        data: {
          status: VerificationStatus.VERIFIED,
          reviewedAt: new Date(),
          reviewedBy: this.reviewer.name,
          notes: verdict.notes,
          ...extractedData,
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { verificationStatus: VerificationStatus.VERIFIED },
      }),
    ]);

    this.logger.log(
      `Account verified for user ${userId} (reviewer: ${this.reviewer.name})`,
    );
    return true;
  }
}
