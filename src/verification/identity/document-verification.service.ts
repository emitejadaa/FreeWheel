import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DocumentVerification,
  DocumentVerificationStatus,
  Prisma,
  User,
  VerificationStatus,
  VerifiedDocumentType,
} from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditLogService } from "../../common/services/audit-log.service";
import { assertFound } from "../../common/utils/entity.util";
import {
  DniDocverifyResult,
  DocverifyResponse,
  LicenseDocverifyResult,
} from "../docverify/docverify.types";
import { PythonDocverifyService } from "../docverify/python-docverify.service";
import {
  VerificationReason,
  verificationReason,
} from "../errors/verification-reasons";
import {
  DocumentMatchResult,
  DocumentMatchService,
} from "../matching/document-match.service";
import { InspectDocumentDto } from "../dto/inspect-document.dto";
import { SubmitDocumentDto } from "../dto/submit-document.dto";
import {
  DocumentKind,
  IdentityDocumentsService,
  IdentityUrlInspection,
} from "./identity-documents.service";

/**
 * Cómo se revisan los documentos (DOCVERIFY_MODE):
 * - "auto" (default): el verificador Python extrae los datos y el matcher
 *   decide. Si Python no está instalado en el servidor, el módulo cae a
 *   "manual" con una advertencia al arrancar.
 * - "manual": nada se aprueba solo; todo entra a la cola del admin.
 * - "auto_approve": aprueba todo. Solo desarrollo y tests.
 */
export type DocverifyMode = "auto" | "manual" | "auto_approve";
export const DOCVERIFY_MODE = "DOCVERIFY_MODE";

const KIND_TO_TYPE: Record<DocumentKind, VerifiedDocumentType> = {
  dni: VerifiedDocumentType.DNI,
  license: VerifiedDocumentType.LICENSE,
};

/** Datos del perfil que hacen falta para poder comparar un documento. */
const REQUIRED_PROFILE_FIELDS: { field: keyof User; label: string }[] = [
  { field: "firstName", label: "nombre" },
  { field: "lastName", label: "apellido" },
  { field: "dateOfBirth", label: "fecha de nacimiento" },
  { field: "dni", label: "DNI" },
  { field: "cuil", label: "CUIL" },
  { field: "address", label: "domicilio" },
];

/** Proyección sin datos personales: lo que ve el propio usuario. */
export interface DocumentVerificationView {
  id: string;
  type: VerifiedDocumentType;
  status: DocumentVerificationStatus;
  reasons: VerificationReason[];
  documents: { front: boolean; back: boolean };
  /** El usuario puede volver a mandar fotos de este documento. */
  canResubmit: boolean;
  /** El usuario puede pedir que un admin revise este resultado. */
  canRequestManualReview: boolean;
  reviewRequestedAt: Date | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * EL FLUJO DE VERIFICACIÓN DE UN DOCUMENTO
 *
 * DNI y licencia son flujos separados: cada uno tiene su fila viva en
 * DocumentVerification y se puede verificar solo o junto con el otro. La
 * cuenta queda VERIFIED cuando AMBOS documentos están aprobados (más el
 * email, y el teléfono si REQUIRE_PHONE_VERIFICATION lo exige).
 *
 * Ciclo de vida de una submission:
 *   submit → APPROVED | FAILED
 *   FAILED → (reenviar fotos: reemplaza y borra las anteriores)
 *          → (pedir revisión) MANUAL_REVIEW → admin: APPROVED | REJECTED
 *   REJECTED → los archivos se borran; se puede volver a empezar.
 */
@Injectable()
export class DocumentVerificationService {
  private readonly logger = new Logger(DocumentVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: IdentityDocumentsService,
    private readonly docverify: PythonDocverifyService,
    private readonly matcher: DocumentMatchService,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
    @Inject(DOCVERIFY_MODE) private readonly mode: DocverifyMode,
  ) {}

  // ── Flujo del usuario ──────────────────────────────────────────────────

  async submit(
    userId: string,
    kind: DocumentKind,
    dto: SubmitDocumentDto,
  ): Promise<DocumentVerificationView> {
    const user = await this.getUser(userId);
    const type = KIND_TO_TYPE[kind];

    this.assertProfileComplete(user);

    const existing = await this.prisma.documentVerification.findUnique({
      where: { userId_type: { userId, type } },
    });
    if (existing?.status === DocumentVerificationStatus.APPROVED) {
      throw new BadRequestException({
        statusCode: 400,
        code: "DOCUMENT_ALREADY_APPROVED",
        message: "Este documento ya está verificado",
      });
    }
    if (existing?.status === DocumentVerificationStatus.MANUAL_REVIEW) {
      throw new BadRequestException({
        statusCode: 400,
        code: "REVIEW_IN_PROGRESS",
        message:
          "Este documento está esperando la revisión de un administrador",
      });
    }

    // Las URLs deben ser nuestras, del slot correcto, de esta cuenta y
    // existir; se persiste la forma canónica sin firma.
    const urls = await this.documents.validateSubmission(userId, kind, dto);

    const outcome = await this.review(user, kind, urls);

    const row = await this.persistOutcome(user, type, existing, urls, outcome);

    await this.recomputeAccountStatus(userId);

    await this.auditLog.create({
      targetUserId: userId,
      action: "identity.document.submit",
      entityType: "DocumentVerification",
      entityId: row.id,
      metadata: {
        type,
        status: row.status,
        reasonCodes: row.reasonCodes,
        mode: this.mode,
      },
    });

    return this.toPublicView(row);
  }

  /**
   * Diagnóstico de una URL suelta, sin efectos: la misma validación que hace
   * el submit pero devolviendo el motivo en vez de un 400. Le permite al
   * front señalar la foto mal cargada antes de gastar un intento.
   */
  inspectUrl(
    userId: string,
    dto: InspectDocumentDto,
  ): Promise<IdentityUrlInspection> {
    return this.documents.inspect(userId, dto.document, dto.side, dto.url);
  }

  async requestManualReview(
    userId: string,
    kind: DocumentKind,
  ): Promise<DocumentVerificationView> {
    const type = KIND_TO_TYPE[kind];
    const row = await this.prisma.documentVerification.findUnique({
      where: { userId_type: { userId, type } },
    });
    assertFound(row, "No hay documentos enviados para revisar");

    if (row.status !== DocumentVerificationStatus.FAILED) {
      throw new BadRequestException({
        statusCode: 400,
        code: "REVIEW_NOT_AVAILABLE",
        message:
          row.status === DocumentVerificationStatus.MANUAL_REVIEW
            ? "Este documento ya está esperando la revisión de un administrador"
            : row.status === DocumentVerificationStatus.APPROVED
              ? "Este documento ya está verificado"
              : "Este documento fue rechazado: volvé a enviar las fotos",
      });
    }

    const updated = await this.prisma.documentVerification.update({
      where: { id: row.id },
      data: {
        status: DocumentVerificationStatus.MANUAL_REVIEW,
        reviewRequestedAt: new Date(),
      },
    });

    await this.auditLog.create({
      targetUserId: userId,
      action: "identity.document.review_requested",
      entityType: "DocumentVerification",
      entityId: row.id,
      metadata: { type },
    });

    return this.toPublicView(updated);
  }

  /** Estado de ambos flujos para el usuario. */
  async getMyDocuments(userId: string): Promise<{
    dni: DocumentVerificationView | null;
    license: DocumentVerificationView | null;
  }> {
    const rows = await this.prisma.documentVerification.findMany({
      where: { userId },
    });
    const byType = new Map(rows.map((row) => [row.type, row]));
    const dni = byType.get(VerifiedDocumentType.DNI);
    const license = byType.get(VerifiedDocumentType.LICENSE);
    return {
      dni: dni ? this.toPublicView(dni) : null,
      license: license ? this.toPublicView(license) : null,
    };
  }

  // ── Veredicto del admin (lo consume AdminService) ──────────────────────

  async adminReview(
    actorId: string,
    verificationId: string,
    decision: "APPROVED" | "REJECTED",
    notes?: string,
  ): Promise<DocumentVerification> {
    const row = await this.prisma.documentVerification.findUnique({
      where: { id: verificationId },
    });
    assertFound(row, "Verification not found");

    // Un rechazo se puede aplicar en cualquier momento: es también la vía
    // para REVOCAR un documento ya aprobado si después se detecta un
    // problema (y borra sus archivos). Aprobar, en cambio, solo tiene
    // sentido sobre algo pendiente: un REJECTED ya no tiene fotos que mirar.
    if (row.status === DocumentVerificationStatus.REJECTED) {
      throw new BadRequestException({
        statusCode: 400,
        code: "REVIEW_NOT_PENDING",
        message:
          "Esta verificación ya fue rechazada: el usuario debe volver a enviar las fotos",
      });
    }
    if (
      decision === "APPROVED" &&
      row.status === DocumentVerificationStatus.APPROVED
    ) {
      throw new BadRequestException({
        statusCode: 400,
        code: "DOCUMENT_ALREADY_APPROVED",
        message: "Este documento ya está verificado",
      });
    }

    let updated: DocumentVerification;
    if (decision === "APPROVED") {
      // Antifraude: una misma identidad no puede verificar dos cuentas.
      if (row.documentNumber) {
        const clash = await this.prisma.documentVerification.findFirst({
          where: {
            documentNumber: row.documentNumber,
            type: row.type,
            status: DocumentVerificationStatus.APPROVED,
            userId: { not: row.userId },
          },
          select: { id: true },
        });
        if (clash) {
          throw new BadRequestException({
            statusCode: 400,
            code: "DOCUMENT_ALREADY_VERIFIED",
            message: "Este documento ya está verificado en otra cuenta",
          });
        }
      }
      updated = await this.prisma.documentVerification.update({
        where: { id: row.id },
        data: {
          status: DocumentVerificationStatus.APPROVED,
          reasonCodes: [],
          notes,
          reviewedBy: actorId,
          reviewedAt: new Date(),
        },
      });
    } else {
      // Rechazo manual: la documentación se borra del storage.
      await this.documents.deleteDocuments([row.frontUrl, row.backUrl]);
      const reason = verificationReason("RECHAZADO_POR_ADMIN");
      updated = await this.prisma.documentVerification.update({
        where: { id: row.id },
        data: {
          status: DocumentVerificationStatus.REJECTED,
          frontUrl: null,
          backUrl: null,
          reasonCodes: [reason.code],
          matchReport: JSON.parse(
            JSON.stringify({ reasons: [reason] }),
          ) as Prisma.InputJsonValue,
          notes,
          reviewedBy: actorId,
          reviewedAt: new Date(),
        },
      });
    }

    await this.recomputeAccountStatus(row.userId);

    await this.auditLog.create({
      actorId,
      targetUserId: row.userId,
      action: "admin.verification.review",
      entityType: "DocumentVerification",
      entityId: row.id,
      metadata: { type: row.type, decision },
    });

    return updated;
  }

  // ── Estado de la cuenta ────────────────────────────────────────────────

  /**
   * Recalcula User.verificationStatus a partir del email, el teléfono y los
   * DOS documentos. Se llama cada vez que algo de eso cambia. VERIFIED
   * exige ambos documentos aprobados; un documento rechazado por un admin
   * deja la cuenta REJECTED hasta que se reenvíe.
   */
  async recomputeAccountStatus(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { documentVerifications: true },
    });
    if (!user) return;

    const byType = new Map(
      user.documentVerifications.map((row) => [row.type, row]),
    );
    const dni = byType.get(VerifiedDocumentType.DNI);
    const license = byType.get(VerifiedDocumentType.LICENSE);

    const emailVerified = Boolean(user.emailVerifiedAt);
    const phoneVerified = Boolean(user.phoneVerifiedAt);
    const phoneRequired = this.isPhoneVerificationRequired();
    const bothApproved =
      dni?.status === DocumentVerificationStatus.APPROVED &&
      license?.status === DocumentVerificationStatus.APPROVED;

    let next: VerificationStatus;
    if (bothApproved && emailVerified && (!phoneRequired || phoneVerified)) {
      next = VerificationStatus.VERIFIED;
    } else if (
      dni?.status === DocumentVerificationStatus.REJECTED ||
      license?.status === DocumentVerificationStatus.REJECTED
    ) {
      next = VerificationStatus.REJECTED;
    } else if (dni || license) {
      next = VerificationStatus.ID_SUBMITTED;
    } else if (emailVerified && phoneVerified) {
      next = VerificationStatus.PHONE_VERIFIED;
    } else if (emailVerified) {
      next = VerificationStatus.EMAIL_VERIFIED;
    } else if (phoneVerified) {
      next = VerificationStatus.PHONE_VERIFIED;
    } else {
      next = VerificationStatus.UNVERIFIED;
    }

    if (next !== user.verificationStatus) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { verificationStatus: next },
      });
      this.logger.log(
        `verificationStatus de ${userId}: ${user.verificationStatus} → ${next}`,
      );
    }
  }

  isPhoneVerificationRequired(): boolean {
    return (
      (
        this.config.get<string>("REQUIRE_PHONE_VERIFICATION") ?? "false"
      ).toLowerCase() === "true"
    );
  }

  /** ¿Este usuario tiene algún documento aprobado? (bloquea editar identidad) */
  async hasApprovedDocument(userId: string): Promise<boolean> {
    const approved = await this.prisma.documentVerification.findFirst({
      where: { userId, status: DocumentVerificationStatus.APPROVED },
      select: { id: true },
    });
    return Boolean(approved);
  }

  // ── Internos ───────────────────────────────────────────────────────────

  /**
   * Corre la revisión según el modo. Nunca lanza por un problema del
   * verificador: eso se convierte en un resultado no aprobado con motivo
   * claro, para que el usuario pueda reintentar o pedir revisión manual.
   */
  private async review(
    user: User,
    kind: DocumentKind,
    urls: { frontUrl: string; backUrl: string },
  ): Promise<{
    match: DocumentMatchResult | null;
    extracted: DocverifyResponse | null;
    manual: boolean;
  }> {
    if (this.mode === "auto_approve") {
      return {
        match: {
          approved: true,
          reasons: [],
          matrix: [],
          documentNumber: user.dni,
          expiresAt: null,
        },
        extracted: null,
        manual: false,
      };
    }
    if (this.mode === "manual") {
      return { match: null, extracted: null, manual: true };
    }

    // Cada etapa se atrapa por separado: si algo se cae, el motivo dice en
    // CUÁL se cayó. Antes las tres compartían un catch y el usuario (y el
    // log) solo veían "la verificación no está disponible".
    let extracted: DocverifyResponse;
    try {
      const [front, back] = await Promise.all([
        this.documents.download(urls.frontUrl),
        this.documents.download(urls.backUrl),
      ]);

      const slots =
        kind === "dni"
          ? { dni_front: front.bytes, dni_back: back.bytes }
          : { license_front: front.bytes, license_back: back.bytes };

      try {
        extracted = await this.docverify.analyze(slots);
      } catch (error) {
        return this.unavailable(
          user.id,
          "lectura",
          "el lector de documentos no pudo procesar las fotos",
          error,
        );
      }
    } catch (error) {
      return this.unavailable(
        user.id,
        "descarga",
        "no pudimos leer las fotos que subiste desde el almacenamiento",
        error,
      );
    }

    try {
      const documentos = extracted.documentos ?? {};

      const profile = {
        firstName: user.firstName,
        lastName: user.lastName,
        dateOfBirth: user.dateOfBirth,
        dni: user.dni,
        cuil: user.cuil,
        address: user.address,
      };

      const match =
        kind === "dni"
          ? this.matcher.matchDni(
              profile,
              documentos as unknown as DniDocverifyResult,
            )
          : this.matcher.matchLicense(
              profile,
              documentos as unknown as LicenseDocverifyResult,
            );

      return { match, extracted, manual: false };
    } catch (error) {
      const failed = this.unavailable(
        user.id,
        "comparación",
        "no pudimos comparar el documento con los datos de tu cuenta",
        error,
      );
      // Lo extraído sí sirve: es lo que va a mirar el admin en la revisión.
      return { ...failed, extracted };
    }
  }

  /**
   * Un fallo de infraestructura convertido en veredicto no aprobado, con la
   * etapa registrada en el log y nombrada en el mensaje del usuario.
   */
  private unavailable(
    userId: string,
    stage: "descarga" | "lectura" | "comparación",
    detail: string,
    error: unknown,
  ): {
    match: DocumentMatchResult;
    extracted: DocverifyResponse | null;
    manual: false;
  } {
    this.logger.error(
      `La verificación automática de ${userId} falló en la etapa "${stage}": ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return {
      match: {
        approved: false,
        reasons: [verificationReason("VERIFICACION_NO_DISPONIBLE", { detail })],
        matrix: [],
        documentNumber: null,
        expiresAt: null,
      },
      extracted: null,
      manual: false,
    };
  }

  /**
   * Reemplaza (o crea) la fila viva del documento. Antes de pisar una
   * submission anterior se borran sus archivos del storage: no deben quedar
   * documentos huérfanos. El veredicto aprobado pasa además el control
   * antifraude dentro de la transacción.
   */
  private async persistOutcome(
    user: User,
    type: VerifiedDocumentType,
    existing: DocumentVerification | null,
    urls: { frontUrl: string; backUrl: string },
    outcome: {
      match: DocumentMatchResult | null;
      extracted: DocverifyResponse | null;
      manual: boolean;
    },
  ): Promise<DocumentVerification> {
    if (existing) {
      const previous = [existing.frontUrl, existing.backUrl].filter(
        (url) => url && url !== urls.frontUrl && url !== urls.backUrl,
      );
      await this.documents.deleteDocuments(previous);
    }

    let match = outcome.match;
    let status: DocumentVerificationStatus;
    if (outcome.manual) {
      status = DocumentVerificationStatus.MANUAL_REVIEW;
    } else if (match?.approved) {
      status = DocumentVerificationStatus.APPROVED;
    } else {
      status = DocumentVerificationStatus.FAILED;
    }

    return this.prisma.$transaction(async (tx) => {
      // Antifraude: el número extraído del documento no puede estar ya
      // verificado en otra cuenta (User.dni único cubre lo declarado; esto
      // cubre lo realmente leído del documento).
      if (
        status === DocumentVerificationStatus.APPROVED &&
        match?.documentNumber
      ) {
        const clash = await tx.documentVerification.findFirst({
          where: {
            documentNumber: match.documentNumber,
            type,
            status: DocumentVerificationStatus.APPROVED,
            userId: { not: user.id },
          },
          select: { id: true },
        });
        if (clash) {
          status = DocumentVerificationStatus.FAILED;
          match = {
            ...match,
            approved: false,
            reasons: [verificationReason("DOCUMENTO_YA_VERIFICADO")],
          };
          this.logger.warn(
            `Documento de ${user.id} ya verificado en otra cuenta`,
          );
        }
      }

      const data = {
        status,
        frontUrl: urls.frontUrl,
        backUrl: urls.backUrl,
        documentNumber: match?.documentNumber ?? null,
        expiresAt: match?.expiresAt
          ? new Date(`${match.expiresAt}T00:00:00.000Z`)
          : null,
        extracted: toJson(outcome.extracted),
        matchReport: match
          ? toJson({ reasons: match.reasons, matrix: match.matrix })
          : toJson(null),
        reasonCodes: match ? match.reasons.map((reason) => reason.code) : [],
        reviewRequestedAt:
          status === DocumentVerificationStatus.MANUAL_REVIEW
            ? new Date()
            : null,
        reviewedBy: null,
        reviewedAt: null,
        notes: null,
      };

      if (existing) {
        return tx.documentVerification.update({
          where: { id: existing.id },
          data,
        });
      }
      return tx.documentVerification.create({
        data: { userId: user.id, type, ...data },
      });
    });
  }

  private assertProfileComplete(user: User): void {
    if (!user.emailVerifiedAt) {
      throw new BadRequestException({
        statusCode: 400,
        code: "EMAIL_NOT_VERIFIED",
        message: "Verificá tu email antes de enviar documentos",
      });
    }
    const missing = REQUIRED_PROFILE_FIELDS.filter(
      ({ field }) => !user[field],
    ).map(({ label }) => label);
    if (missing.length > 0) {
      const reason = verificationReason("PERFIL_INCOMPLETO", { missing });
      throw new BadRequestException({
        statusCode: 400,
        code: reason.code,
        message: reason.message,
        missing,
      });
    }
  }

  toPublicView(row: DocumentVerification): DocumentVerificationView {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      reasons: readReasons(row.matchReport),
      documents: { front: Boolean(row.frontUrl), back: Boolean(row.backUrl) },
      canResubmit:
        row.status !== DocumentVerificationStatus.APPROVED &&
        row.status !== DocumentVerificationStatus.MANUAL_REVIEW,
      canRequestManualReview: row.status === DocumentVerificationStatus.FAILED,
      reviewRequestedAt: row.reviewRequestedAt,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async getUser(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    assertFound(user, "User not found");
    return user;
  }
}

/** Motivos guardados en matchReport, tolerando filas sin reporte. */
export function readReasons(matchReport: unknown): VerificationReason[] {
  if (
    matchReport &&
    typeof matchReport === "object" &&
    Array.isArray((matchReport as { reasons?: unknown }).reasons)
  ) {
    return (matchReport as { reasons: VerificationReason[] }).reasons.filter(
      (reason) => reason && typeof reason.code === "string",
    );
  }
  return [];
}

/** Normaliza a JSON plano (sin Date ni undefined) para una columna Json. */
function toJson(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
