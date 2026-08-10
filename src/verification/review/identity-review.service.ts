import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  User,
  UserVerification,
  VerificationStatus,
} from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditLogService } from "../../common/services/audit-log.service";
import { withTimeout } from "../../common/utils/with-timeout.util";
import { IDENTITY_REVIEWER } from "./identity-reviewer.interface";
import type {
  IdentityReviewer,
  IdentityReviewVerdict,
} from "./identity-reviewer.interface";

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
  identityDataProvided: boolean;
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
    // Datos de identidad cargados a mano contra los que la revisión documental
    // cruza lo que dicen el DNI y la licencia; sin ellos no hay qué comparar.
    identityDataProvided: Boolean(user.dni && user.cuil && user.address),
  };
}

const DEFAULT_REVIEW_TIMEOUT_MS = 45_000;

/**
 * Runs after every verification event (email confirm, phone confirm, identity
 * submit, complete-profile, profile update): when the whole checklist is
 * complete, the configured reviewer decides and the submission is resolved.
 * Callers never know which review mode is active.
 */
@Injectable()
export class IdentityReviewService {
  private readonly logger = new Logger(IdentityReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDENTITY_REVIEWER) private readonly reviewer: IdentityReviewer,
    private readonly auditLog: AuditLogService,
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
    // El teléfono solo bloquea si está configurado como obligatorio.
    const phonePending =
      isPhoneVerificationRequired(this.config) && !checklist.phoneVerified;

    if (
      !checklist.emailVerified ||
      phonePending ||
      !checklist.dateOfBirthProvided ||
      !checklist.identityDataProvided
    ) {
      return false;
    }

    const verdict = await this.runReview(user, submission);

    if (verdict.outcome === "approved") {
      return this.applyApproval(user, submission, verdict);
    }
    if (verdict.outcome === "rejected") {
      await this.applyRejection(user, submission, verdict);
      return false;
    }

    await this.applyInconclusive(user, submission, verdict);
    return false;
  }

  /**
   * La revisión corre dentro del request (no hay infraestructura de jobs), así
   * que se le pone presupuesto de tiempo y se atrapan sus errores: quedarse
   * sin tiempo o fallar deja el caso pendiente para el admin, nunca un 500 ni
   * un rechazo injusto.
   */
  private async runReview(
    user: User,
    submission: UserVerification & {
      dniFrontUrl: string;
      dniBackUrl: string;
      licenseFrontUrl: string;
      licenseBackUrl: string;
    },
  ): Promise<IdentityReviewVerdict> {
    const timeoutMs =
      Number(this.config.get<string>("IDENTITY_REVIEW_TIMEOUT_MS")) ||
      DEFAULT_REVIEW_TIMEOUT_MS;

    const input = {
      userId: user.id,
      verificationId: submission.id,
      dniFrontUrl: submission.dniFrontUrl,
      dniBackUrl: submission.dniBackUrl,
      licenseFrontUrl: submission.licenseFrontUrl,
      licenseBackUrl: submission.licenseBackUrl,
      selfieUrl: submission.selfieUrl,
      profile: {
        firstName: user.firstName,
        lastName: user.lastName,
        dateOfBirth: user.dateOfBirth,
        dni: user.dni,
        cuil: user.cuil,
        address: user.address,
      },
    };

    try {
      return await withTimeout(this.reviewer.review(input), timeoutMs, () => {
        this.logger.warn(
          `Identity review timed out after ${timeoutMs}ms for user ${user.id}`,
        );
        return {
          outcome: "inconclusive" as const,
          reasonCodes: ["REVIEW_TIMEOUT"],
          notes: "La revisión automática no terminó a tiempo",
        };
      });
    } catch (error) {
      // El detalle del error puede traer datos del documento: se registra el
      // mensaje en el log del servidor, no en la base ni en la respuesta.
      this.logger.error(
        `Identity review failed for user ${user.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        outcome: "inconclusive",
        reasonCodes: ["REVIEW_ERROR"],
        notes: "La revisión automática falló",
      };
    }
  }

  private async applyApproval(
    user: User,
    submission: UserVerification,
    verdict: IdentityReviewVerdict,
  ): Promise<boolean> {
    const documentNumber = verdict.documentNumber ?? null;

    const approved = await this.prisma.$transaction(async (tx) => {
      // Antifraude: una misma identidad no puede verificar dos cuentas. El
      // índice único de User.dni cubre el dato declarado; esto cubre el dato
      // realmente extraído del documento.
      if (documentNumber) {
        const clash = await tx.userVerification.findFirst({
          where: {
            documentNumber,
            status: VerificationStatus.VERIFIED,
            userId: { not: user.id },
          },
          select: { id: true },
        });
        if (clash) return false;
      }

      await tx.userVerification.update({
        where: { id: submission.id },
        data: {
          ...this.reviewColumns(verdict),
          status: VerificationStatus.VERIFIED,
          reviewedAt: new Date(),
        },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { verificationStatus: VerificationStatus.VERIFIED },
      });
      return true;
    });

    if (!approved) {
      this.logger.warn(
        `Identity review approved user ${user.id} but the document is already verified on another account`,
      );
      await this.applyInconclusive(user, submission, {
        ...verdict,
        outcome: "inconclusive",
        reasonCodes: ["DNI_ALREADY_VERIFIED"],
        notes: "El documento ya está verificado en otra cuenta",
      });
      return false;
    }

    await this.audit(user, submission, "approved", verdict);
    this.logger.log(
      `Account verified for user ${user.id} (reviewer: ${this.reviewer.name})`,
    );
    return true;
  }

  private async applyRejection(
    user: User,
    submission: UserVerification,
    verdict: IdentityReviewVerdict,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.userVerification.update({
        where: { id: submission.id },
        data: {
          ...this.reviewColumns(verdict),
          status: VerificationStatus.REJECTED,
          reviewedAt: new Date(),
        },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { verificationStatus: VerificationStatus.REJECTED },
      }),
    ]);

    await this.audit(user, submission, "rejected", verdict);
    this.logger.log(
      `Identity rejected for user ${user.id} (reviewer: ${this.reviewer.name})`,
    );
  }

  /** Guarda el reporte y deja el caso ID_SUBMITTED para la cola del admin. */
  private async applyInconclusive(
    user: User,
    submission: UserVerification,
    verdict: IdentityReviewVerdict,
  ): Promise<void> {
    await this.prisma.userVerification.update({
      where: { id: submission.id },
      data: this.reviewColumns(verdict),
    });

    await this.audit(user, submission, "inconclusive", verdict);
  }

  private reviewColumns(verdict: IdentityReviewVerdict) {
    const data: Prisma.UserVerificationUpdateInput = {
      reviewedBy: this.reviewer.name,
      notes: verdict.notes,
    };
    if (verdict.extracted !== undefined) data.extracted = verdict.extracted;
    if (verdict.matchReport !== undefined) {
      data.matchReport = verdict.matchReport;
    }
    if (verdict.documentNumber !== undefined) {
      data.documentNumber = verdict.documentNumber;
    }
    if (verdict.fullNameOnDocument !== undefined) {
      data.fullNameOnDocument = verdict.fullNameOnDocument;
    }
    if (verdict.licenseExpiresAt !== undefined) {
      data.licenseExpiresAt = verdict.licenseExpiresAt;
    }
    return data;
  }

  /**
   * Minimización de datos (Ley 25.326): la auditoría guarda el veredicto y los
   * códigos de motivo, nunca los datos extraídos del documento.
   */
  private audit(
    user: User,
    submission: UserVerification,
    outcome: string,
    verdict: IdentityReviewVerdict,
  ) {
    return this.auditLog.create({
      targetUserId: user.id,
      action: "identity.review.auto",
      entityType: "UserVerification",
      entityId: submission.id,
      metadata: {
        outcome,
        reviewer: this.reviewer.name,
        reasonCodes: verdict.reasonCodes,
      },
    });
  }
}
