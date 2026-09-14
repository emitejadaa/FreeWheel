import { BadRequestException, Injectable, Logger } from "@nestjs/common";
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
  VerificationReason,
  verificationReason,
} from "../errors/verification-reasons";
import { InspectDocumentDto } from "../dto/inspect-document.dto";
import { SubmitDocumentDto } from "../dto/submit-document.dto";
import {
  DocumentKind,
  IdentityDocumentsService,
  IdentityUrlInspection,
} from "./identity-documents.service";

const KIND_TO_TYPE: Record<DocumentKind, VerifiedDocumentType> = {
  dni: VerifiedDocumentType.DNI,
  license: VerifiedDocumentType.LICENSE,
};

/**
 * Datos del perfil que hacen falta para poder revisar un documento: son
 * exactamente los que el admin tiene que poder contrastar contra la foto.
 * Sin ellos la revisión no tiene contra qué comparar.
 */
const REQUIRED_PROFILE_FIELDS: { field: keyof User; label: string }[] = [
  { field: "firstName", label: "nombre" },
  { field: "lastName", label: "apellido" },
  { field: "dateOfBirth", label: "fecha de nacimiento" },
  { field: "dni", label: "DNI" },
  { field: "cuil", label: "CUIL" },
  { field: "address", label: "domicilio" },
];

/** Lo que ve el propio usuario sobre uno de sus documentos. */
export interface DocumentVerificationView {
  id: string;
  type: VerifiedDocumentType;
  status: DocumentVerificationStatus;
  reasons: VerificationReason[];
  documents: { front: boolean; back: boolean };
  /** El usuario puede volver a mandar fotos de este documento. */
  canResubmit: boolean;
  /** El usuario puede pedir que un admin revise este documento. */
  canRequestManualReview: boolean;
  reviewRequestedAt: Date | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * EL FLUJO DE VERIFICACIÓN DE UN DOCUMENTO — REVISIÓN MANUAL
 *
 * Este backend NO analiza las fotos: solo las recibe, las guarda y las pone a
 * disposición de un admin. La lectura automática de documentos vive en un
 * servicio aparte (ver docverify-api/), que se deploya por su cuenta y no está
 * conectado con este: acá no hay ningún cliente que lo llame.
 *
 * DNI y licencia son flujos separados: cada uno tiene su fila viva en
 * DocumentVerification y se puede enviar solo o junto con el otro. La cuenta
 * queda VERIFIED cuando AMBOS documentos están aprobados (más el email, y el
 * teléfono si REQUIRE_PHONE_VERIFICATION lo exige).
 *
 * Ciclo de vida de una submission:
 *   submit → PENDING            (fotos guardadas, todavía sin revisar)
 *   PENDING → (pedir revisión) MANUAL_REVIEW → admin: APPROVED | REJECTED
 *   PENDING → (reenviar fotos: reemplaza y borra las anteriores)
 *   REJECTED → los archivos se borran; se puede volver a empezar.
 */
@Injectable()
export class DocumentVerificationService {
  private readonly logger = new Logger(DocumentVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: IdentityDocumentsService,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
  ) {}

  // ── Flujo del usuario ──────────────────────────────────────────────────

  /**
   * Guarda las dos fotos de un documento y lo deja PENDING. No se analiza
   * nada acá: el siguiente paso lo da el usuario pidiendo la revisión.
   */
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
    // Una revisión manual pendiente NO bloquea reenviar fotos: hay UNA
    // revisión viva por documento y la última que se pide es la que vale.
    // Mandar fotos nuevas reemplaza lo que hubiera —el pedido de revisión
    // incluido, que queda sin efecto— porque el admin tiene que mirar ESTAS
    // fotos y no las anteriores. Lo aplica persistOutcome, que pisa la fila
    // entera y limpia reviewRequestedAt.

    // Las URLs deben ser nuestras, del slot correcto, de esta cuenta y
    // existir; se persiste la forma canónica sin firma.
    const urls = await this.documents.validateSubmission(userId, kind, dto);

    const row = await this.persistSubmission(user, type, existing, urls);

    await this.recomputeAccountStatus(userId);

    await this.auditLog.create({
      targetUserId: userId,
      action: "identity.document.submit",
      entityType: "DocumentVerification",
      entityId: row.id,
      metadata: { type, status: row.status },
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

  /**
   * Manda el documento a la cola del admin. Se puede pedir sobre un PENDING
   * (el caso normal) y también sobre un FAILED, que es el estado en el que
   * quedaron las submissions de la verificación automática vieja.
   */
  async requestManualReview(
    userId: string,
    kind: DocumentKind,
  ): Promise<DocumentVerificationView> {
    const type = KIND_TO_TYPE[kind];
    const row = await this.prisma.documentVerification.findUnique({
      where: { userId_type: { userId, type } },
    });
    assertFound(row, "No hay documentos enviados para revisar");

    const revisable =
      row.status === DocumentVerificationStatus.PENDING ||
      row.status === DocumentVerificationStatus.FAILED;
    if (!revisable) {
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

  /**
   * Cómo revisa documentos este servidor. Quedó como un endpoint de una sola
   * respuesta —siempre manual— para que el front no tenga que ramificar por
   * versión de backend: antes acá se informaba el modo de la verificación
   * automática, que ya no existe.
   */
  diagnostics(): {
    mode: "manual";
    canVerifyAutomatically: false;
    detail: string;
  } {
    return {
      mode: "manual",
      canVerifyAutomatically: false,
      detail:
        "Este backend no analiza las fotos: las guarda y un administrador las " +
        "revisa. La lectura automática de documentos corre en un servicio " +
        "aparte, que se deploya por su cuenta y no está conectado con este.",
    };
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
   * Reemplaza (o crea) la fila viva del documento, en PENDING. Antes de pisar
   * una submission anterior se borran sus archivos del storage: no deben
   * quedar documentos huérfanos.
   *
   * `documentNumber` se guarda del DNI declarado en el perfil —en Argentina el
   * número de licencia ES el del DNI— y es lo que después usa el control
   * antifraude del admin para no aprobar la misma identidad en dos cuentas.
   */
  private async persistSubmission(
    user: User,
    type: VerifiedDocumentType,
    existing: DocumentVerification | null,
    urls: { frontUrl: string; backUrl: string },
  ): Promise<DocumentVerification> {
    if (existing) {
      const previous = [existing.frontUrl, existing.backUrl].filter(
        (url) => url && url !== urls.frontUrl && url !== urls.backUrl,
      );
      await this.documents.deleteDocuments(previous);

      if (existing.status === DocumentVerificationStatus.MANUAL_REVIEW) {
        this.logger.log(
          `La revisión manual pendiente de ${user.id} (${type}) queda sin ` +
            "efecto: se enviaron fotos nuevas.",
        );
      }
    }

    const data = {
      status: DocumentVerificationStatus.PENDING,
      frontUrl: urls.frontUrl,
      backUrl: urls.backUrl,
      documentNumber: user.dni,
      expiresAt: null,
      matchReport: Prisma.JsonNull,
      reasonCodes: [],
      reviewRequestedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      notes: null,
    };

    if (existing) {
      return this.prisma.documentVerification.update({
        where: { id: existing.id },
        data,
      });
    }
    return this.prisma.documentVerification.create({
      data: { userId: user.id, type, ...data },
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
      // Reenviar fotos se puede SIEMPRE salvo que ya esté aprobado. Con una
      // revisión manual pendiente también: mandar fotos nuevas la reemplaza.
      canResubmit: row.status !== DocumentVerificationStatus.APPROVED,
      // Pedir revisión tiene sentido sobre un documento enviado y todavía sin
      // resolver. Si ya está pedida, no se vuelve a pedir.
      canRequestManualReview:
        row.status === DocumentVerificationStatus.PENDING ||
        row.status === DocumentVerificationStatus.FAILED,
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
