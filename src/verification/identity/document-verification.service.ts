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
  FieldMatrixRow,
} from "../matching/document-match.service";
import { SubmitDocumentDto } from "../dto/submit-document.dto";
import {
  DocumentKind,
  IdentityDocumentsService,
} from "./identity-documents.service";

/**
 * Cómo se revisan los documentos (DOCVERIFY_MODE):
 * - "auto" (default): el verificador Python extrae los datos y el matcher
 *   decide.
 * - "manual": DECISIÓN DEL OPERADOR — nada se aprueba solo; todo entra a la
 *   cola del admin.
 * - "auto_approve": aprueba todo. Solo desarrollo y tests.
 * - "unavailable": se pidió "auto" y este servidor NO puede correrlo (sin
 *   Python, sin las credenciales del storage, sin verificador remoto).
 *
 * "unavailable" NO ES LO MISMO QUE "manual", y confundirlos es lo que rompía
 * el flujo. Antes los dos casos mandaban el documento a la cola del admin, así
 * que en un servidor sin Python —Vercel serverless, por ejemplo— TODA
 * submission quedaba en MANUAL_REVIEW sin que nadie la hubiera pedido, y el
 * siguiente intento se rechazaba con "está esperando la revisión de un
 * administrador". La persona quedaba trabada sin haber hecho nada.
 *
 * Ahora son dos cosas distintas: "manual" es alguien decidiendo que revisa a
 * mano, y "unavailable" es una falla del servidor, que termina en FAILED con
 * un motivo que lo dice. Desde FAILED se puede reenviar fotos y se puede pedir
 * revisión manual: la persona conserva las dos salidas.
 */
export type DocverifyMode = "auto" | "manual" | "auto_approve" | "unavailable";

/**
 * El modo efectivo con el que arrancó el servidor, y por qué.
 *
 * Lleva el motivo adentro porque sin eso el diagnóstico era imposible:
 * `/health/env` informaba el DOCVERIFY_MODE *configurado* ("auto"), el
 * servidor se comportaba como otro, y nada en ninguna respuesta decía que
 * había degradado ni por qué.
 */
export interface DocverifyModeInfo {
  mode: DocverifyMode;
  /** Lo que pedía la configuración ("auto" cuando no se configuró nada). */
  configured: string;
  /** Por qué el modo efectivo no es el configurado. null si coinciden. */
  degradedReason: string | null;
}

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

/**
 * TODO lo que el servidor leyó del documento y todo lo que comparó.
 *
 * Es el material para entender POR QUÉ un documento no se aprobó: qué leyó
 * cada protocolo (OCR, PDF417, MRZ), campo por campo, y cómo se comparó cada
 * uno contra los datos de la cuenta. Sin esto, un FAILED era una pared: el
 * motivo decía "el nombre no coincide" y no había forma de saber si el
 * problema era la foto, el OCR o un dato mal cargado en el perfil.
 *
 * Se expone al DUEÑO del documento —son sus propios datos, no los de un
 * tercero— y lo controla VERIFICATION_EXPOSE_EXTRACTION. Los admins lo ven
 * siempre por GET /admin/verifications/:id.
 */
export interface DocumentExtractionReport {
  /** Con qué modo corrió esta revisión, y por qué si degradó. */
  mode: DocverifyMode;
  degradedReason: string | null;
  /** El JSON crudo del verificador, tal cual: un objeto por foto y protocolo. */
  extracted: DocverifyResponse | null;
  /** La comparación campo por campo: qué dijo cada fuente y si cerró. */
  matrix: FieldMatrixRow[];
  /** El número leído del documento (no el declarado en el perfil). */
  documentNumber: string | null;
  /** Vencimiento leído del documento, ISO AAAA-MM-DD. */
  expiresAt: string | null;
}

/** Lo que ve el propio usuario sobre uno de sus documentos. */
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
  /** Ver DocumentExtractionReport. null cuando está apagado por config. */
  extraction: DocumentExtractionReport | null;
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
    @Inject(DOCVERIFY_MODE) private readonly modeInfo: DocverifyModeInfo,
  ) {}

  /** El modo efectivo de este servidor. */
  private get mode(): DocverifyMode {
    return this.modeInfo.mode;
  }

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
    // Una revisión manual pendiente NO bloquea reenviar fotos.
    //
    // Antes sí lo hacía, y era la trampa: en un servidor sin verificador la
    // primera submission caía sola en MANUAL_REVIEW y a partir de ahí toda
    // submission daba 400. La persona quedaba encerrada en una cola que nunca
    // pidió, sin forma de reintentar.
    //
    // La regla es que hay UNA revisión viva por documento y la última que se
    // pide es la que vale: mandar fotos nuevas reemplaza lo que hubiera —el
    // pedido de revisión manual incluido, que queda sin efecto— porque se está
    // pidiendo una revisión automática sobre OTROS archivos. Lo aplica
    // persistOutcome, que pisa la fila entera y limpia reviewRequestedAt.
    //
    // Y después de esta submission se puede volver a pedir revisión manual: la
    // que se pida va a ser sobre estas fotos y este resultado, no sobre los
    // anteriores.

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

  /**
   * POR QUÉ este servidor verifica (o no) de forma automática.
   *
   * Sale a la red a preguntarle al verificador si contesta. Existe porque "la
   * verificación no anda" tenía demasiadas causas posibles y ninguna forma de
   * distinguirlas desde afuera: el servidor decía DOCVERIFY_MODE=auto en el
   * diagnóstico, se comportaba como manual, y nada explicaba el salto.
   *
   * No devuelve ni la URL ni el token del verificador: solo si hay uno, de qué
   * tipo, y si responde.
   */
  async diagnostics(): Promise<{
    mode: DocverifyMode;
    configured: string;
    degradedReason: string | null;
    canVerifyAutomatically: boolean;
    exposeExtraction: boolean;
    verifier: Awaited<ReturnType<PythonDocverifyService["probe"]>>;
  }> {
    return {
      mode: this.mode,
      configured: this.modeInfo.configured,
      degradedReason: this.modeInfo.degradedReason,
      canVerifyAutomatically: this.mode === "auto",
      exposeExtraction: this.exposeExtraction,
      verifier: await this.docverify.probe(),
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
    // Decisión del operador: nadie se aprueba solo, todo a la cola del admin.
    if (this.mode === "manual") {
      return { match: null, extracted: null, manual: true };
    }

    // El servidor NO PUEDE verificar (sin Python, sin tesseract, sin
    // credenciales del storage, sin verificador remoto). Eso es una falla del
    // servidor, no una decisión: termina FAILED con un motivo que lo dice, y la
    // persona conserva las dos salidas —reenviar fotos, o pedir revisión
    // manual— en vez de quedar encolada sin haberlo pedido.
    if (this.mode === "unavailable") {
      this.logger.warn(
        `Submission de ${user.id} sin verificación automática: ` +
          (this.modeInfo.degradedReason ?? "motivo desconocido"),
      );
      return {
        match: {
          approved: false,
          reasons: [
            verificationReason("VERIFICACION_NO_DISPONIBLE", {
              detail: this.modeInfo.degradedReason ?? undefined,
            }),
          ],
          matrix: [],
          documentNumber: null,
          expiresAt: null,
        },
        extracted: null,
        manual: false,
      };
    }

    try {
      const [front, back] = await Promise.all([
        this.documents.download(urls.frontUrl),
        this.documents.download(urls.backUrl),
      ]);

      const slots =
        kind === "dni"
          ? { dni_front: front.bytes, dni_back: back.bytes }
          : { license_front: front.bytes, license_back: back.bytes };

      const extracted = await this.docverify.analyze(slots);
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
      this.logger.error(
        `La verificación automática falló para ${user.id}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return {
        match: {
          approved: false,
          reasons: [verificationReason("VERIFICACION_NO_DISPONIBLE")],
          matrix: [],
          documentNumber: null,
          expiresAt: null,
        },
        extracted: null,
        manual: false,
      };
    }
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

      if (existing.status === DocumentVerificationStatus.MANUAL_REVIEW) {
        this.logger.log(
          `La revisión manual pendiente de ${user.id} (${type}) queda sin ` +
            "efecto: se enviaron fotos nuevas.",
        );
      }
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
      // Reenviar fotos se puede SIEMPRE salvo que ya esté aprobado. Con una
      // revisión manual pendiente también: mandar fotos nuevas la reemplaza.
      canResubmit: row.status !== DocumentVerificationStatus.APPROVED,
      // Pedir revisión manual tiene sentido sobre un resultado automático que
      // no aprobó. Si ya está pedida, no se vuelve a pedir.
      canRequestManualReview: row.status === DocumentVerificationStatus.FAILED,
      reviewRequestedAt: row.reviewRequestedAt,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      extraction: this.exposeExtraction ? this.extractionReport(row) : null,
    };
  }

  /**
   * ¿Se le devuelve a la persona todo lo que se leyó de su documento?
   *
   * Son SUS datos, no los de un tercero, y verlos es la única forma de darse
   * cuenta de que la foto salió movida o de que el perfil tiene el apellido mal
   * escrito. Cualquier verificador de identidad serio te muestra qué leyó.
   *
   * Se puede apagar con VERIFICATION_EXPOSE_EXTRACTION="false": lo que se filtra
   * al mostrarlo no son datos personales sino la mecánica de la comparación, y
   * eso le sirve a quien esté probando cómo falsificar un documento. Mientras
   * esto sea una demo, verlo vale más que esconderlo.
   */
  private get exposeExtraction(): boolean {
    const flag = (
      this.config.get<string>("VERIFICATION_EXPOSE_EXTRACTION") ?? ""
    ).toLowerCase();
    if (flag === "false") return false;
    return true;
  }

  private extractionReport(
    row: DocumentVerification,
  ): DocumentExtractionReport {
    return {
      mode: this.mode,
      degradedReason: this.modeInfo.degradedReason,
      extracted: (row.extracted as DocverifyResponse | null) ?? null,
      matrix: readMatrix(row.matchReport),
      documentNumber: row.documentNumber,
      expiresAt: row.expiresAt
        ? row.expiresAt.toISOString().slice(0, 10)
        : null,
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

/** La matriz de evidencia guardada en matchReport, tolerando filas viejas. */
export function readMatrix(matchReport: unknown): FieldMatrixRow[] {
  if (
    matchReport &&
    typeof matchReport === "object" &&
    Array.isArray((matchReport as { matrix?: unknown }).matrix)
  ) {
    return (matchReport as { matrix: FieldMatrixRow[] }).matrix.filter(
      (row) => row && typeof row.field === "string",
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
