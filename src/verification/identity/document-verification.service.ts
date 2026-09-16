import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "crypto";
import {
  DocumentAnalysisStatus,
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
import {
  DocverifyClient,
  DocverifyDocument,
  DocverifyResult,
} from "./docverify.client";
import { ExtractedFacts, IdentityMatchService } from "./identity-match.service";

const KIND_TO_TYPE: Record<DocumentKind, VerifiedDocumentType> = {
  dni: VerifiedDocumentType.DNI,
  license: VerifiedDocumentType.LICENSE,
};

/** Cómo nombra cada documento la API que los lee. */
const KIND_TO_DOCVERIFY: Record<DocumentKind, DocverifyDocument> = {
  dni: "dni",
  license: "licencia",
};

/**
 * Datos del perfil que hacen falta para poder revisar un documento: son
 * exactamente los que el cruce automático —y el admin, si le toca mirar— van a
 * contrastar contra la foto. Sin ellos la revisión no tiene contra qué
 * comparar.
 *
 * EL DOMICILIO NO ESTÁ, y no es un olvido. No se cruza contra nada (ver la
 * cabecera de identity-match.service.ts: el de la cuenta lo escribe una
 * persona y el del documento lo devuelve un OCR sobre letra chica, así que
 * casi nunca son el mismo texto aunque sean el mismo lugar). Exigirlo
 * frenaba el envío de documentos por un dato que después no decide nada.
 */
const REQUIRED_PROFILE_FIELDS: { field: keyof User; label: string }[] = [
  { field: "firstName", label: "nombre" },
  { field: "lastName", label: "apellido" },
  { field: "dateOfBirth", label: "fecha de nacimiento" },
  { field: "dni", label: "DNI" },
  { field: "cuil", label: "CUIL" },
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
  /**
   * En qué anda la lectura automática. El front lo usa para mostrar
   * "revisando tus documentos…" y para dejar de preguntar cuando terminó.
   */
  analysis: {
    status: DocumentAnalysisStatus;
    /** Si vale la pena volver a preguntar dentro de unos segundos. */
    pending: boolean;
    /** Por qué no se pudo leer, en castellano. Vacío si no falló. */
    error: string | null;
    /**
     * Si volver a pedir el análisis puede salir bien
     * (`POST /verification/identity/:document/retry-analysis`).
     *
     * Es true sobre todo en el caso del servicio dormido: el pedido que se
     * cayó fue el que lo despertó, así que el siguiente lo encuentra andando.
     * El front puede reintentar solo una vez y, si vuelve a fallar, dejar que
     * siga por revisión manual.
     */
    canRetry: boolean;
  };
  /** Cuándo vence este documento, si se pudo leer. */
  expiresAt: Date | null;
  reviewRequestedAt: Date | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * EL FLUJO DE VERIFICACIÓN DE UN DOCUMENTO
 *
 * Las fotos las LEE un servicio aparte, escrito en Python, que se deploya por
 * su cuenta (ver docverify-api/). Este backend le manda las dos caras, recibe
 * lo que leyó, lo CRUZA contra los datos de la cuenta y decide.
 *
 * ── La lectura es asíncrona, y el usuario no espera ─────────────────────────
 * Analizar un documento son varios segundos por cara y los análisis no pueden
 * correr en paralelo. Así que el submit guarda las fotos, dispara el análisis
 * y contesta enseguida; cuando la lectura termina, el servicio nos pega de
 * vuelta a `applyAnalysis` y ahí se aplica el veredicto. Mientras tanto el
 * documento está PENDING con `analysisStatus` en QUEUED, que es lo que el
 * front muestra como "revisando tus documentos".
 *
 * ── Aprueba solo; rechazar es de personas ───────────────────────────────────
 * Si todo coincide, el documento queda APPROVED sin que intervenga nadie. Si
 * algo no cierra —un dato que no coincide, una foto que no se pudo leer, el
 * servicio de lectura caído— va a MANUAL_REVIEW con el informe ya armado, para
 * que el admin resuelva en segundos en vez de leer cuatro fotos. Lo que NUNCA
 * pasa es un rechazo automático: un OCR equivocándose no puede ser la última
 * palabra sobre la identidad de una persona.
 *
 * Corolario: que la lectura automática falle no bloquea a nadie. Es un
 * acelerador, no un requisito.
 *
 * DNI y licencia son flujos separados: cada uno tiene su fila viva en
 * DocumentVerification y se puede enviar solo o junto con el otro. La cuenta
 * queda VERIFIED cuando AMBOS documentos están aprobados (más el email, y el
 * teléfono si REQUIRE_PHONE_VERIFICATION lo exige).
 *
 * Ciclo de vida de una submission:
 *   submit → PENDING + análisis QUEUED     (fotos guardadas, lectura pedida)
 *   análisis DONE  → APPROVED  (todo cruzó)
 *                  → PENDING   (algo no cerró; el usuario puede pedir revisión)
 *   análisis FAILED→ PENDING   (no se pudo leer; camino manual, con el motivo)
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
    private readonly docverify: DocverifyClient,
    private readonly matcher: IdentityMatchService,
  ) {}

  // ── Flujo del usuario ──────────────────────────────────────────────────

  /**
   * Guarda las dos fotos de un documento, dispara su lectura y contesta.
   *
   * No espera el análisis: la respuesta sale con el documento en PENDING y el
   * análisis QUEUED, y el front consulta `GET /verification/identity/me` hasta
   * que cambie. Ver la nota de la clase sobre por qué es asíncrono.
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

    return this.toPublicView(await this.startAnalysis(row, kind, urls));
  }

  /**
   * Le pide a la API de lectura que analice este documento.
   *
   * Devuelve la fila actualizada y NO LANZA NUNCA: cuando no se puede pedir el
   * análisis —el servicio está caído, no está configurado, está saturado— el
   * documento queda igual de válido, en PENDING y con el motivo guardado, y
   * sigue por revisión manual. Que nuestra lectura automática no ande no es
   * problema del usuario y no le puede trabar la cuenta.
   */
  private async startAnalysis(
    row: DocumentVerification,
    kind: DocumentKind,
    urls: { frontUrl: string; backUrl: string },
  ): Promise<DocumentVerification> {
    // El token viaja al servicio de lectura y vuelve en el aviso; acá se
    // guarda solo su hash. Es de un solo uso: se borra al consumirlo, así que
    // un aviso repetido —o uno de un análisis viejo, después de que el usuario
    // reenviara fotos— no encuentra a quién aplicarse.
    const token = randomBytes(32).toString("hex");

    await this.prisma.documentVerification.update({
      where: { id: row.id },
      data: {
        analysisStatus: DocumentAnalysisStatus.QUEUED,
        analysisRequestedAt: new Date(),
        analysisTokenHash: hashToken(token),
        analysisError: null,
      },
    });

    const result = await this.docverify.requestAnalysis({
      document: KIND_TO_DOCVERIFY[kind],
      frontUrl: urls.frontUrl,
      backUrl: urls.backUrl,
      reference: row.id,
      callbackUrl: `${this.publicUrl()}/verification/identity/analysis-callback`,
      callbackToken: token,
    });

    if (result.accepted) {
      return this.prisma.documentVerification.findUniqueOrThrow({
        where: { id: row.id },
      });
    }

    this.logger.warn(
      `no se pudo pedir el análisis de ${row.id} ` +
        `(${result.failure.problem}): ${result.failure.detail}`,
    );

    // El mensaje va a `analysisError` y NO a `reasonCodes`.
    //
    // La diferencia importa: `reasons` es "qué está mal con TU documento" y el
    // front lo muestra como tal. Que nuestro servicio de lectura esté caído, o
    // que este deploy no tenga ninguno configurado, no es nada que el usuario
    // haya hecho mal ni algo que pueda arreglar reenviando fotos. Meterlo ahí
    // le mostraría un problema en su documento que no existe.
    //
    // Va a `analysisError`, que el front recibe en `analysis.error` y muestra
    // como lo que es: un aviso de que esto lo va a mirar una persona.
    const reason = verificationReason(
      result.failure.problem === "NO_CONFIGURADO"
        ? "LECTURA_NO_DISPONIBLE"
        : "LECTURA_FALLIDA",
      { detail: shortDetail(result.failure.detail) },
    );

    return this.prisma.documentVerification.update({
      where: { id: row.id },
      data: {
        analysisStatus: DocumentAnalysisStatus.FAILED,
        // El token se borra: el análisis no arrancó, así que ningún aviso
        // legítimo puede llegar con él.
        analysisTokenHash: null,
        analysisError: reason.message,
      },
    });
  }

  /**
   * EL AVISO DE QUE UN ANÁLISIS TERMINÓ.
   *
   * Entra sin sesión: lo llama la API de lectura, que no es un usuario. Lo
   * único que la autentica es el token de un solo uso que le dimos al pedir el
   * análisis, y que solo ella conoce.
   *
   * Un token que no matchea es un 401 y nada más: no se dice si la referencia
   * existe ni en qué estado está, porque quien pregunta no demostró tener
   * derecho a saberlo.
   */
  async applyAnalysis(
    token: string,
    result: DocverifyResult,
  ): Promise<{ applied: true; status: DocumentVerificationStatus }> {
    const row = await this.prisma.documentVerification.findUnique({
      where: { analysisTokenHash: hashToken(token) },
    });
    if (!row) {
      // Pasa legítimamente cuando el usuario reenvió fotos mientras el
      // análisis anterior corría: ese análisis ya no describe las fotos que
      // hay guardadas, así que descartarlo es lo correcto.
      throw new UnauthorizedException({
        statusCode: 401,
        code: "ANALYSIS_TOKEN_INVALID",
        message:
          "El token del análisis no corresponde a ningún pedido vigente. " +
          "Puede que las fotos se hayan reemplazado mientras se analizaba.",
      });
    }

    const user = await this.getUser(row.userId);
    const report = this.matcher.evaluate(row.type, result, user);

    this.logger.log(
      `análisis de ${row.type} de ${row.userId}: ${report.verdict}` +
        (report.reasons.length
          ? ` · ${report.reasons.map((r) => r.code).join(", ")}`
          : ""),
    );

    const aprobar = report.verdict === "APPROVE";
    // El antifraude corre también acá: sin esto, la aprobación automática
    // sería el camino para verificar dos cuentas con el mismo documento, que
    // es justo lo que el control del admin impide.
    const duplicado = aprobar
      ? await this.findDuplicate(row, report.facts.documentNumber ?? user.dni)
      : false;

    const reasons = duplicado
      ? [...report.reasons, verificationReason("DOCUMENTO_YA_VERIFICADO")]
      : report.reasons;
    // Un análisis que no aprueba deja el documento donde estaba, y eso importa
    // cuando el documento YA estaba en la cola del admin: la persona corrigió
    // sus datos, volvió a pedir la lectura y volvió a no cerrar. Bajarlo a
    // PENDING ahí lo sacaría de la cola —perdería su lugar, y el pedido de
    // revisión que ya había hecho— por haber intentado destrabarse solo.
    const status =
      aprobar && !duplicado
        ? DocumentVerificationStatus.APPROVED
        : row.status === DocumentVerificationStatus.MANUAL_REVIEW
          ? DocumentVerificationStatus.MANUAL_REVIEW
          : DocumentVerificationStatus.PENDING;

    const updated = await this.prisma.documentVerification.update({
      where: { id: row.id },
      data: {
        status,
        analysisStatus: DocumentAnalysisStatus.DONE,
        // Consumido: el aviso vale una sola vez.
        analysisTokenHash: null,
        analysisError: null,
        expiresAt: report.facts.expiresAt,
        documentNumber: report.facts.documentNumber ?? row.documentNumber,
        extracted: JSON.parse(JSON.stringify(report)) as Prisma.InputJsonValue,
        matchReport: JSON.parse(
          JSON.stringify({ reasons }),
        ) as Prisma.InputJsonValue,
        reasonCodes: reasons.map((r) => r.code),
        ...(status === DocumentVerificationStatus.APPROVED
          ? { reviewedBy: null, reviewedAt: new Date() }
          : {}),
      },
    });

    if (status === DocumentVerificationStatus.APPROVED) {
      await this.applyFactsToUser(row.userId, row.type, report.facts);
    }

    await this.recomputeAccountStatus(row.userId);

    await this.auditLog.create({
      targetUserId: row.userId,
      action: "identity.document.analyzed",
      entityType: "DocumentVerification",
      entityId: row.id,
      metadata: {
        type: row.type,
        verdict: report.verdict,
        status,
        reasons: reasons.map((r) => r.code),
      },
    });

    return { applied: true, status: updated.status };
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
   * Vuelve a pedir el análisis de un documento que ya está enviado.
   *
   * EXISTE POR EL SERVICIO DORMIDO. En un plan gratuito el servicio de lectura
   * se apaga por inactividad, y despertarlo tarda más de lo que una función
   * serverless puede esperar: el primer pedido después de un rato se cae
   * SIEMPRE. Pero ese pedido fallido es justamente el que lo despertó, así que
   * el siguiente lo encuentra andando. Sin esta vía, cada rato de inactividad
   * se traducía en una verificación que iba a revisión manual sin necesidad.
   *
   * No reenvía las fotos ni las toca: son las mismas que ya están guardadas.
   */
  async retryAnalysis(
    userId: string,
    kind: DocumentKind,
  ): Promise<DocumentVerificationView> {
    const type = KIND_TO_TYPE[kind];
    const row = await this.prisma.documentVerification.findUnique({
      where: { userId_type: { userId, type } },
    });
    assertFound(row, "No hay documentos enviados para analizar");

    if (!canRetryAnalysis(row)) {
      throw new BadRequestException({
        statusCode: 400,
        code: "ANALYSIS_RETRY_NOT_AVAILABLE",
        message:
          row.analysisStatus === DocumentAnalysisStatus.QUEUED
            ? // Un QUEUED reciente: hay uno corriendo de verdad.
              "El análisis de este documento ya está en curso: esperá el resultado."
            : row.status === DocumentVerificationStatus.APPROVED
              ? "Este documento ya está verificado."
              : row.status === DocumentVerificationStatus.REJECTED
                ? "Este documento fue rechazado: volvé a enviar las fotos."
                : "Este documento ya no tiene fotos guardadas: volvé a enviarlas.",
      });
    }

    const updated = await this.startAnalysis(row, kind, {
      frontUrl: row.frontUrl as string,
      backUrl: row.backUrl as string,
    });

    await this.auditLog.create({
      targetUserId: userId,
      action: "identity.document.analysis_retried",
      entityType: "DocumentVerification",
      entityId: row.id,
      metadata: { type, status: updated.analysisStatus },
    });

    return this.toPublicView(updated);
  }

  /**
   * Cómo revisa documentos este servidor.
   *
   * Sirve para saber, sin subir una foto, si este deploy tiene configurada la
   * lectura automática. Un deploy sin DOCVERIFY_URL funciona igual —todo pasa
   * por revisión manual— y esto es lo que lo dice en voz alta, en vez de que
   * se note porque las verificaciones tardan días.
   */
  diagnostics(): {
    mode: "automatic" | "manual";
    canVerifyAutomatically: boolean;
    /**
     * Si este backend tiene con qué autenticarse contra el servicio de
     * lectura. Se informa aparte de `mode` porque un deploy con la URL puesta
     * y el token vacío se ve "automático" desde afuera y no lo es: el lector
     * publicado lo rechaza con 401 y todo termina en revisión manual, sin que
     * nada diga por qué.
     */
    readerTokenConfigured: boolean;
    detail: string;
  } {
    const automatico = this.docverify.isConfigured();
    const conCallback = Boolean(this.publicUrl());
    const conToken = this.docverify.hasToken();

    if (automatico && conCallback) {
      return {
        mode: "automatic",
        canVerifyAutomatically: true,
        readerTokenConfigured: conToken,
        detail:
          "Las fotos se leen automáticamente y se cruzan contra los datos de " +
          "la cuenta. Si todo coincide el documento se aprueba solo; si algo " +
          "no cierra, lo revisa un administrador." +
          (conToken
            ? ""
            : " OJO: falta DOCVERIFY_TOKEN, así que los pedidos salen sin la " +
              "clave compartida y un lector publicado los va a rechazar."),
      };
    }
    return {
      mode: "manual",
      canVerifyAutomatically: false,
      readerTokenConfigured: conToken,
      detail: !automatico
        ? "Este deploy no tiene configurada la lectura automática " +
          "(falta DOCVERIFY_URL): los documentos los revisa un administrador."
        : "La lectura automática está configurada pero este deploy no sabe su " +
          "propia URL pública (falta PUBLIC_URL o VERCEL_URL), así que no " +
          "podría recibir el resultado: los documentos los revisa un " +
          "administrador.",
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
      if (await this.findDuplicate(row, row.documentNumber)) {
        const reason = verificationReason("DOCUMENTO_YA_VERIFICADO");
        throw new BadRequestException({
          statusCode: 400,
          code: "DOCUMENT_ALREADY_VERIFIED",
          message: reason.message,
        });
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
      // Un admin puede estar aprobando un documento que la lectura automática
      // no pudo resolver sola, pero que igual leyó: el vencimiento y la clase
      // están guardados y son los que después habilitan a manejar. Sin esto,
      // toda licencia aprobada a mano quedaría sin vencimiento conocido y no
      // habilitaría nada.
      await this.applyFactsToUser(row.userId, row.type, factsOf(updated));
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
          expiresAt: null,
          extracted: Prisma.JsonNull,
          analysisStatus: DocumentAnalysisStatus.NOT_REQUESTED,
          analysisTokenHash: null,
          analysisError: null,
          reasonCodes: [reason.code],
          matchReport: JSON.parse(
            JSON.stringify({ reasons: [reason] }),
          ) as Prisma.InputJsonValue,
          notes,
          reviewedBy: actorId,
          reviewedAt: new Date(),
        },
      });
      // Rechazar es también la vía para REVOCAR un documento ya aprobado. Lo
      // que ese documento habilitaba se va con él: si no, una licencia
      // revocada seguiría dejando alquilar autos hasta su fecha de
      // vencimiento.
      await this.applyFactsToUser(row.userId, row.type, VACIO);
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
   * ¿Esta misma identidad ya está verificada en OTRA cuenta?
   *
   * Es el control antifraude de fondo, y corre tanto en la aprobación
   * automática como en la del admin. Un documento sin número leído no se puede
   * contrastar: en ese caso no se bloquea —no hay evidencia de nada— y la
   * decisión queda en manos de quien revisa.
   */
  private async findDuplicate(
    row: DocumentVerification,
    documentNumber: string | null,
  ): Promise<boolean> {
    if (!documentNumber) return false;
    const clash = await this.prisma.documentVerification.findFirst({
      where: {
        documentNumber,
        type: row.type,
        status: DocumentVerificationStatus.APPROVED,
        userId: { not: row.userId },
      },
      select: { id: true },
    });
    return Boolean(clash);
  }

  /**
   * Copia al usuario lo que el documento aportó y el formulario no tenía.
   *
   * ESTÁ DUPLICADO A PROPÓSITO. Los mismos datos ya viven en la fila de
   * DocumentVerification; se copian al usuario porque son los que se consultan
   * en CADA pedido para saber si puede alquilar un auto, y JwtStrategy ya trae
   * el usuario entero. Tenerlos acá convierte ese control en cero consultas
   * extra, y el único precio es acordarse de limpiarlos cuando el documento se
   * revoca — que es lo que hace la llamada con VACIO desde el rechazo.
   */
  private async applyFactsToUser(
    userId: string,
    type: VerifiedDocumentType,
    facts: ExtractedFacts,
  ): Promise<void> {
    const data =
      type === VerifiedDocumentType.LICENSE
        ? {
            licenseExpiresAt: facts.expiresAt,
            licenseClass: facts.licenseClass,
            licenseIssuedAt: facts.licenseIssuedAt,
            licenseBeginnerUntil: facts.licenseBeginnerUntil,
          }
        : { dniExpiresAt: facts.expiresAt };

    await this.prisma.user.update({ where: { id: userId }, data });
  }

  /**
   * De dónde sale la URL pública de este backend, que es la que se le pasa al
   * servicio de lectura para que nos avise.
   *
   * Tiene que ser alcanzable desde afuera: en Vercel la arma sola con
   * VERCEL_URL (que no trae protocolo), y PUBLIC_URL la pisa cuando hay un
   * dominio propio. Sin ninguna de las dos el callback no puede llegar y el
   * análisis, aunque se haga, no nos vuelve nunca — por eso el pedido ni se
   * intenta y el documento va derecho a revisión manual.
   */
  private publicUrl(): string {
    const explicita = this.config.get<string>("PUBLIC_URL")?.trim();
    if (explicita) return explicita.replace(/\/+$/, "");

    const vercel = this.config.get<string>("VERCEL_URL")?.trim();
    if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;

    // Corriendo en la máquina de alguien, la URL propia se puede deducir y no
    // hace falta que nadie la configure: es localhost y el puerto en el que
    // estamos escuchando. Sin esto, levantar el proyecto entero en local dejaba
    // la lectura automática apagada por una variable que no era evidente que
    // faltara — y el síntoma era silencioso: los documentos se guardaban y se
    // quedaban esperando a un admin.
    //
    // Va acotado a NODE_ENV !== production para que en un deploy sin PUBLIC_URL
    // ni VERCEL_URL esto devuelva "" y el análisis directamente no se pida.
    // Adivinar "localhost" ahí sería peor que no configurar nada: la API de
    // lectura mandaría el resultado a su propio localhost y se perdería en
    // silencio, cada vez.
    if (this.config.get<string>("NODE_ENV") !== "production") {
      return `http://localhost:${this.config.get<string>("PORT") ?? "3000"}`;
    }
    return "";
  }

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
      // Provisorio: el número que el usuario declaró. Cuando la lectura
      // termine se reemplaza por el que dice el documento, que es el que
      // tiene que sostener el control antifraude — el declarado lo elige el
      // usuario, el leído no.
      documentNumber: user.dni,
      expiresAt: null,
      matchReport: Prisma.JsonNull,
      reasonCodes: [],
      // Fotos nuevas, análisis nuevo: lo que se había leído de las anteriores
      // no describe a estas. El token del análisis viejo se borra acá, y eso
      // es lo que hace que su aviso —si llega tarde— no se aplique.
      extracted: Prisma.JsonNull,
      analysisStatus: DocumentAnalysisStatus.NOT_REQUESTED,
      analysisRequestedAt: null,
      analysisTokenHash: null,
      analysisError: null,
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
      analysis: {
        status: row.analysisStatus,
        // Un análisis abandonado ya no está "en curso" por más que la columna
        // diga QUEUED: nadie lo está haciendo. Decir que sí dejaría al front
        // esperando un resultado que no va a llegar.
        pending:
          row.analysisStatus === DocumentAnalysisStatus.QUEUED &&
          !analisisAbandonado(row),
        error: analisisAbandonado(row)
          ? "La revisión automática de tus documentos se interrumpió. Podés " +
            "volver a intentarla, o esperar a que un administrador los revise."
          : row.analysisError,
        canRetry: canRetryAnalysis(row),
      },
      expiresAt: row.expiresAt,
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

/**
 * Cuánto se espera un análisis antes de darlo por perdido.
 *
 * Diez minutos es holgado incluso para el peor caso conocido —una instancia
 * chica, con la cola llena y CPU al tope— y a la vez bastante menos de lo que
 * una persona está dispuesta a mirar una pantalla que dice "revisando".
 */
const ANALISIS_ABANDONADO_MS = 10 * 60 * 1000;

/**
 * Un análisis que se pidió y del que nunca volvimos a saber nada.
 *
 * PASA DE VERDAD, y no por un error nuestro: si el proceso que estaba
 * analizando muere a la mitad —lo mata el sistema por memoria, la plataforma lo
 * reinicia, se cae la máquina— no queda nadie para avisar que falló. El aviso
 * que teníamos que recibir no llega nunca.
 *
 * Sin esto la fila se quedaba en QUEUED PARA SIEMPRE: el front mostraba
 * "revisando tus documentos" sin fin, `canRetry` daba false porque el estado no
 * era FAILED, y la persona no tenía ninguna forma de destrabarse. Un estado del
 * que solo se sale recibiendo un mensaje necesita, siempre, una salida por
 * tiempo.
 */
function analisisAbandonado(row: DocumentVerification): boolean {
  if (row.analysisStatus !== DocumentAnalysisStatus.QUEUED) return false;
  const pedido = row.analysisRequestedAt?.getTime();
  return pedido !== undefined && Date.now() - pedido > ANALISIS_ABANDONADO_MS;
}

/**
 * Si volver a pedir el análisis de este documento puede servir de algo.
 *
 * Hacen falta tres cosas, y cada una descarta un caso distinto:
 *
 *   · que no haya un análisis CORRIENDO — si está QUEUED y todavía es reciente
 *     ya hay uno en curso, y pedir otro duplicaría el trabajo del servicio de
 *     lectura, que es justamente el recurso escaso;
 *   · que las fotos sigan guardadas — un documento rechazado ya no las tiene,
 *     así que no hay nada para analizar;
 *   · que el documento no esté resuelto — aprobado o rechazado, la lectura ya
 *     no cambia nada.
 *
 * UN ANÁLISIS TERMINADO (DONE) TAMBIÉN SE PUEDE VOLVER A PEDIR, y ese es el
 * caso que más se usa: el cruce no es solo contra la foto, es contra los datos
 * de la cuenta. Cuando el veredicto fue "la fecha de nacimiento del documento
 * no coincide con la de tu cuenta", lo que hay que corregir está en el perfil,
 * no en la foto — y después de corregirlo el MISMO análisis da otro resultado.
 * Exigir que el análisis hubiera FALLADO dejaba a esa persona con un botón que
 * contestaba "no hay nada que reintentar" y sin más salida que volver a sacar
 * y subir las cuatro fotos, que era exactamente lo que el front le prometía
 * que no hacía falta.
 *
 * No se mira si el fallo fue "reintentable": eso lo decide el cliente al
 * momento de fallar y queda reflejado en que la fila haya quedado o no en
 * FAILED con las fotos intactas. Un token mal configurado deja la fila igual,
 * sí — y reintentarlo cuesta un request que vuelve a fallar en un segundo,
 * mucho menos que explicarle a alguien por qué el botón no aparece.
 */
function canRetryAnalysis(row: DocumentVerification): boolean {
  const corriendo =
    row.analysisStatus === DocumentAnalysisStatus.QUEUED &&
    !analisisAbandonado(row);

  return (
    !corriendo &&
    Boolean(row.frontUrl) &&
    Boolean(row.backUrl) &&
    row.status !== DocumentVerificationStatus.APPROVED &&
    row.status !== DocumentVerificationStatus.REJECTED
  );
}

/**
 * El token del callback, hasheado.
 *
 * SHA-256 pelado y no bcrypt, a diferencia de una contraseña, y el motivo es
 * que acá no hace falta el costo: el token son 32 bytes aleatorios, no algo
 * que alguien pueda adivinar probando. Lo que se busca es que quien lea la
 * base no pueda falsificar un aviso, y para eso un hash rápido alcanza. Encima
 * tiene que ser determinístico, porque la búsqueda es POR el hash.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Lo que habilita un documento del que no se leyó nada. */
const VACIO: ExtractedFacts = {
  expiresAt: null,
  licenseClass: null,
  licenseIssuedAt: null,
  licenseBeginnerUntil: null,
  documentNumber: null,
};

/**
 * Lo que la lectura sacó de un documento, recuperado de la fila.
 *
 * Se lee de `extracted`, que es donde lo dejó el análisis, y se cae a `VACIO`
 * cuando no hay nada: es el caso de un documento que un admin aprobó sin que
 * la lectura automática hubiera podido correr. Ahí no se sabe cuándo vence la
 * licencia, y no saberlo es distinto de que esté vigente — lo que hace el
 * control de habilitación con un vencimiento desconocido está explicado en
 * driving-eligibility.ts.
 *
 * `expiresAt` sale de la columna y no del JSON porque es la columna la que se
 * mantiene al día: un admin puede corregirla sin tocar el informe.
 */
function factsOf(row: DocumentVerification): ExtractedFacts {
  const report = row.extracted as { facts?: Partial<ExtractedFacts> } | null;
  const facts = report?.facts;
  return {
    expiresAt: row.expiresAt,
    licenseClass: facts?.licenseClass ?? null,
    licenseIssuedAt: aDate(facts?.licenseIssuedAt),
    licenseBeginnerUntil: aDate(facts?.licenseBeginnerUntil),
    documentNumber: row.documentNumber,
  };
}

/**
 * Las fechas guardadas en JSON vuelven como texto ISO, no como Date: Prisma
 * serializa la columna Json tal cual y no reconstruye tipos. Sin esto, lo que
 * se escribiría en User.licenseIssuedAt sería un string y Prisma lo rechazaría
 * en runtime, mucho después de compilar.
 */
function aDate(valor: Date | string | null | undefined): Date | null {
  if (!valor) return null;
  const fecha = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/**
 * Recorta un detalle técnico antes de meterlo en un mensaje para el usuario.
 *
 * Los detalles del cliente pueden traer el cuerpo de una respuesta ajena. Al
 * usuario le sirve saber que el problema fue "timeout" y no el HTML de error
 * de un proxy.
 */
function shortDetail(detail: string): string {
  const limpio = detail.replace(/\s+/g, " ").trim();
  return limpio.length > 160 ? `${limpio.slice(0, 157)}…` : limpio;
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
