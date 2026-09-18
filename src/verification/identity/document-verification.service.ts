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
  ReasonAction,
  VerificationReason,
  verificationReason,
} from "../errors/verification-reasons";
import { InspectDocumentDto } from "../dto/inspect-document.dto";
import { SubmitDocumentDto } from "../dto/submit-document.dto";
import {
  IdentityDocumentsService,
  IdentityUrlInspection,
} from "./identity-documents.service";
import { DocumentKind, DocumentSlot, slotFor, slotsOf } from "./document-slots";
import {
  DocverifyClient,
  DocverifyDocument,
  DocverifyResult,
} from "./docverify.client";
import {
  DeclaredDocumentData,
  IdentityMatchService,
} from "./identity-match.service";

const KIND_TO_TYPE: Record<DocumentKind, VerifiedDocumentType> = {
  dni: VerifiedDocumentType.DNI,
  license: VerifiedDocumentType.LICENSE,
};

const TYPE_TO_KIND: Record<VerifiedDocumentType, DocumentKind> = {
  DNI: "dni",
  LICENSE: "license",
};

/** Cómo nombra cada documento la API que los lee. */
const KIND_TO_DOCVERIFY: Record<DocumentKind, DocverifyDocument> = {
  dni: "dni",
  license: "licencia",
};

/**
 * Datos del PERFIL que hacen falta para poder verificar cualquier documento:
 * son exactamente los que la foto tiene que confirmar.
 *
 * El domicilio ya no está. No se comparaba contra nada, no habilitaba nada, y
 * era el dato más sensible que guardábamos de una persona. La única dirección
 * que el sistema necesita es la del auto, y esa vive en la publicación.
 */
const REQUIRED_PROFILE_FIELDS: { field: keyof User; label: string }[] = [
  { field: "firstName", label: "nombre" },
  { field: "lastName", label: "apellido" },
  { field: "dateOfBirth", label: "fecha de nacimiento" },
  { field: "dni", label: "DNI" },
  { field: "cuil", label: "CUIL" },
];

/**
 * Qué datos hay que DECLARAR de cada documento, con el nombre que tienen en el
 * formulario y el que usaría una persona.
 *
 * Es la lista que hace de contrato con el front: lo que falte sale en
 * `missing` del error DATOS_DEL_DOCUMENTO_FALTANTES, con el nombre del campo,
 * así el front puede marcar el input exacto.
 */
const REQUIRED_DECLARED_FIELDS: Record<
  VerifiedDocumentType,
  { field: keyof SubmitDocumentDto; label: string }[]
> = {
  DNI: [{ field: "expiresAt", label: "fecha de vencimiento del DNI" }],
  LICENSE: [
    { field: "expiresAt", label: "fecha de vencimiento de la licencia" },
    { field: "issuedAt", label: "fecha de otorgamiento de la licencia" },
    { field: "licenseClass", label: "clase de licencia" },
    { field: "isBeginner", label: "si la licencia es de principiante" },
  ],
};

/** Lo que el propio usuario declaró de un documento, tal como se le devuelve. */
export interface DeclaredView {
  expiresAt: string | null;
  issuedAt: string | null;
  licenseClass: string | null;
  isBeginner: boolean | null;
  beginnerUntil: string | null;
}

/** El estado de UNA foto: si está guardada y si hay que sacarla de nuevo. */
export interface PhotoView {
  slot: DocumentSlot;
  side: "front" | "back";
  /** Si hay una foto guardada en este slot. */
  present: boolean;
  /**
   * Si esta foto es la que falló y hay que repetirla. Las que tienen `false`
   * se pueden reutilizar: el front no debería pedirlas de nuevo.
   */
  mustRetake: boolean;
}

/** Lo que ve el propio usuario sobre uno de sus documentos. */
export interface DocumentVerificationView {
  id: string;
  type: VerifiedDocumentType;
  status: DocumentVerificationStatus;
  reasons: VerificationReason[];
  /**
   * QUÉ TIENE QUE HACER LA PERSONA AHORA, en una sola palabra.
   *
   * Sale de los motivos: es la acción del más urgente. El front puede usarla
   * para elegir el botón principal sin recorrer la lista. `null` cuando no hay
   * nada que hacer (aprobado, o esperando a que termine el análisis).
   */
  nextAction: ReasonAction | null;
  documents: { front: boolean; back: boolean };
  /** Estado foto por foto: cuál repetir y cuál se puede reutilizar. */
  photos: PhotoView[];
  /** Los slots de `photos` con mustRetake, sueltos, para ramificar rápido. */
  retakeSlots: DocumentSlot[];
  /** Lo que la persona declaró de este documento. */
  declared: DeclaredView | null;
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
     * Solo es true cuando el análisis no llegó a hacerse: el servicio estaba
     * dormido, caído o no configurado. NUNCA es true sobre un documento que ya
     * tiene veredicto — esas fotos ya se analizaron y volver a analizarlas
     * daría lo mismo. Ahí la salida es mandar fotos nuevas o pedir revisión.
     */
    canRetry: boolean;
  };
  /** Cuándo vence este documento, según lo declarado por su dueño. */
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
 * lo que leyó, lo CRUZA contra lo que la persona declaró y decide.
 *
 * ── Los documentos no se leen: se corroboran ────────────────────────────────
 * Ningún dato sale de la foto para entrar en la base. El vencimiento, la clase
 * de la licencia y el período de principiante los declara la persona, leyendo
 * su propio documento, y la lectura automática dice si la foto coincide. Si
 * coincide, lo declarado pasa a ser la verdad de la cuenta; si no, se dice qué
 * dato y en qué foto.
 *
 * El motivo es concreto: cuando el dato salía del OCR, un "2029" leído como
 * "2019" dejaba una cuenta verificada que no podía reservar, y su dueño no
 * tenía forma de corregir un dato que no había cargado. Ahora equivocarse
 * cuesta un reenvío.
 *
 * ── La lectura es asíncrona, y el usuario no espera ─────────────────────────
 * Analizar un documento son varios segundos por cara y los análisis no pueden
 * correr en paralelo. Así que el submit guarda las fotos, dispara el análisis
 * y contesta enseguida; cuando la lectura termina, el servicio nos pega de
 * vuelta a `applyAnalysis` y ahí se aplica el veredicto. Mientras tanto el
 * documento está PENDING con `analysisStatus` en QUEUED, que es lo que el
 * front muestra como "revisando tus documentos".
 *
 * ── Fallar no es el final ───────────────────────────────────────────────────
 * Un documento que no cierra queda FAILED, con el motivo exacto y QUÉ FOTO hay
 * que repetir. Desde ahí la persona elige: mandar fotos nuevas (y ahí sí se
 * borran las viejas) o pedir que un administrador mire estas mismas. Las fotos
 * de un documento fallado NO se borran solas, porque son justamente lo que el
 * admin necesita mirar. Lo que no se puede es volver a analizarlas: ya tienen
 * veredicto.
 *
 * Un problema NUESTRO —el servicio de lectura caído, sin configurar— no es un
 * documento fallado: la fila queda PENDING con el motivo aparte, y sigue por
 * revisión manual. Que nuestra infraestructura falle no puede aparecerle a una
 * persona como que su documento está mal.
 *
 * ── Un documento vencido se aprueba ─────────────────────────────────────────
 * Es auténtico y es de quien dice ser. Negarle la verificación lo dejaría sin
 * cuenta Y sin poder operar, cuando el problema es uno solo. El vencimiento
 * queda guardado y lo aplica la capa de habilitación: DNI vencido bloquea todo
 * lo sensible, licencia vencida bloquea alquilar.
 *
 * ── DNI y licencia son independientes ───────────────────────────────────────
 * Cada uno tiene su fila viva, se envía cuando su dueño quiere y falla o se
 * aprueba por su cuenta. La cuenta queda VERIFIED con el DNI aprobado (más el
 * email, y el teléfono si REQUIRE_PHONE_VERIFICATION lo exige): es el DNI el
 * que prueba la identidad. La licencia no verifica a nadie — habilita a
 * manejar, que es otra cosa, y por eso alguien que solo alquila su auto no
 * tiene por qué tener una.
 *
 * Ciclo de vida de una submission:
 *   submit → PENDING + análisis QUEUED     (fotos guardadas, lectura pedida)
 *   análisis DONE  → APPROVED  (todo cruzó; lo declarado se copia a la cuenta)
 *                  → FAILED    (algo no cerró; con motivos y fotos a repetir)
 *   análisis FAILED→ PENDING   (problema nuestro; camino manual, con el motivo)
 *   PENDING/FAILED → (pedir revisión) MANUAL_REVIEW → admin: APPROVED|REJECTED
 *   cualquiera     → (reenviar fotos: reemplaza y borra las anteriores)
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
   * Guarda las dos fotos de un documento junto con lo que su dueño declaró,
   * dispara la lectura y contesta.
   *
   * No espera el análisis: la respuesta sale con el documento en PENDING y el
   * análisis QUEUED, y el front consulta `GET /verification/identity/me` hasta
   * que cambie.
   */
  async submit(
    userId: string,
    kind: DocumentKind,
    dto: SubmitDocumentDto,
  ): Promise<DocumentVerificationView> {
    const user = await this.getUser(userId);
    const type = KIND_TO_TYPE[kind];

    this.assertProfileComplete(user);
    const declared = this.parseDeclared(type, dto);

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
    // incluido— porque el admin tiene que mirar ESTAS fotos y no las
    // anteriores. Lo aplica persistSubmission, que pisa la fila entera.

    // Las URLs deben ser nuestras, del slot correcto, de esta cuenta y
    // existir; se persiste la forma canónica sin firma.
    const urls = await this.documents.validateSubmission(userId, kind, dto);

    const row = await this.persistSubmission(
      user,
      type,
      existing,
      urls,
      declared,
    );

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

    // El mensaje va a `analysisError` y NO a `reasonCodes`, y el documento
    // queda PENDING y NO FAILED.
    //
    // La diferencia importa: `reasons` es "qué está mal con TU documento" y el
    // front lo muestra como tal. Que nuestro servicio de lectura esté caído, o
    // que este deploy no tenga ninguno configurado, no es nada que el usuario
    // haya hecho mal ni algo que pueda arreglar reenviando fotos. Marcarlo
    // como documento fallado le mostraría un problema en su documento que no
    // existe.
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

    const declared = readDeclared(row);
    if (!declared) {
      // No debería pasar: el submit no deja crear una fila sin datos
      // declarados. Si pasa —una fila vieja, una migración a medias— el
      // documento no se puede cruzar contra nada, así que va a revisión
      // manual en vez de aprobarse o fallar por algo que no se evaluó.
      return this.parkForManualReview(row, "sin datos declarados");
    }

    const user = await this.getUser(row.userId);
    const report = this.matcher.evaluate(row.type, result, user, declared);

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
      ? await this.findDuplicate(row, row.documentNumber)
      : false;

    const reasons = duplicado
      ? [...report.reasons, verificationReason("DOCUMENTO_YA_VERIFICADO")]
      : report.reasons;
    const status =
      aprobar && !duplicado
        ? DocumentVerificationStatus.APPROVED
        : DocumentVerificationStatus.FAILED;

    const updated = await this.prisma.documentVerification.update({
      where: { id: row.id },
      data: {
        status,
        analysisStatus: DocumentAnalysisStatus.DONE,
        // Consumido: el aviso vale una sola vez.
        analysisTokenHash: null,
        analysisError: null,
        // `checks` guarda SI coincidió cada campo, no QUÉ decía la foto. Lo
        // que decía ya lo tenemos declarado; guardar además la versión de una
        // máquina que puede equivocarse es guardar un dato peor por las dudas.
        checks: JSON.parse(
          JSON.stringify(report.checks),
        ) as Prisma.InputJsonValue,
        matchReport: JSON.parse(
          JSON.stringify({ reasons, analysis: report.analysis }),
        ) as Prisma.InputJsonValue,
        reasonCodes: reasons.map((r) => r.code),
        retakeSlots: report.retakeSlots,
        ...(status === DocumentVerificationStatus.APPROVED
          ? { reviewedBy: null, reviewedAt: new Date() }
          : {}),
      },
    });

    if (status === DocumentVerificationStatus.APPROVED) {
      await this.applyDeclaredToUser(row.userId, row.type, declared);
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
        retakeSlots: report.retakeSlots,
      },
    });

    return { applied: true, status: updated.status };
  }

  /**
   * Deja un documento esperando a un administrador, sin marcarlo como
   * fallado.
   *
   * Es la salida para cuando no pudimos EVALUARLO: una fila sin datos
   * declarados, un caso que el cruce no sabe resolver. No es lo mismo que
   * fallar —no hay nada que el usuario haya hecho mal, así que no se le pide
   * que corrija nada— y por eso no escribe motivos.
   */
  private async parkForManualReview(
    row: DocumentVerification,
    porQue: string,
  ): Promise<{ applied: true; status: DocumentVerificationStatus }> {
    this.logger.warn(
      `el análisis de ${row.id} no se pudo aplicar (${porQue}): ` +
        "queda para revisión manual",
    );
    const reason = verificationReason("LECTURA_NO_DISPONIBLE");
    const updated = await this.prisma.documentVerification.update({
      where: { id: row.id },
      data: {
        status: DocumentVerificationStatus.PENDING,
        analysisStatus: DocumentAnalysisStatus.FAILED,
        analysisTokenHash: null,
        analysisError: reason.message,
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
   * Manda el documento a la cola del admin.
   *
   * Se puede pedir sobre un PENDING (el análisis no se pudo hacer) y sobre un
   * FAILED (el análisis se hizo y algo no cerró). En los dos casos las fotos
   * siguen guardadas, que es justamente lo que el admin tiene que mirar.
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
    if (!row.frontUrl || !row.backUrl) {
      throw new BadRequestException({
        statusCode: 400,
        code: "REVIEW_WITHOUT_PHOTOS",
        message:
          "Este documento ya no tiene fotos guardadas: volvé a enviarlas " +
          "para que un administrador pueda revisarlas.",
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
      metadata: { type, previousStatus: row.status },
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
   * el siguiente lo encuentra andando.
   *
   * NO sirve para reintentar un veredicto. Un documento que ya se analizó y
   * falló no se vuelve a analizar: son las mismas fotos y darían lo mismo. Ahí
   * la salida es mandar fotos nuevas o pedir revisión manual.
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
            : row.analysisStatus === DocumentAnalysisStatus.DONE
              ? "Este documento ya se analizó. Volver a analizar las mismas " +
                "fotos daría el mismo resultado: enviá fotos nuevas o pedí " +
                "que lo revise un administrador."
              : row.status === DocumentVerificationStatus.APPROVED
                ? "Este documento ya está verificado."
                : !row.frontUrl || !row.backUrl
                  ? "Este documento ya no tiene fotos guardadas: volvé a enviarlas."
                  : "No hay nada que reintentar en este documento.",
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
    detail: string;
  } {
    const automatico = this.docverify.isConfigured();
    const conCallback = Boolean(this.publicUrl());

    if (automatico && conCallback) {
      return {
        mode: "automatic",
        canVerifyAutomatically: true,
        detail:
          "Las fotos se leen automáticamente y se cruzan contra los datos que " +
          "cargaste. Si todo coincide el documento se aprueba solo; si algo " +
          "no cierra, te decimos qué dato y qué foto, y podés corregirlo o " +
          "pedir que lo revise un administrador.",
      };
    }
    return {
      mode: "manual",
      canVerifyAutomatically: false,
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
      const declared = readDeclared(row);
      // Aprobar a mano un documento sin datos declarados dejaría la cuenta
      // verificada sin saber cuándo vence nada, que es justo el estado que
      // este rediseño vino a sacar. El admin le pide a la persona que
      // reenvíe el documento con los datos cargados.
      if (!declared) {
        throw new BadRequestException({
          statusCode: 400,
          code: "DECLARED_DATA_MISSING",
          message:
            "Esta submission no tiene los datos del documento (vencimiento, " +
            "clase). Pedile al usuario que lo vuelva a enviar cargándolos: " +
            "sin ellos no se puede saber qué habilita el documento.",
        });
      }
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
          retakeSlots: [],
          matchReport: Prisma.JsonNull,
          notes,
          reviewedBy: actorId,
          reviewedAt: new Date(),
        },
      });
      await this.applyDeclaredToUser(row.userId, row.type, declared);
    } else {
      // Rechazo manual: la documentación se borra del storage. Es el único
      // camino que borra fotos sin que el usuario mande otras, y tiene
      // sentido: un admin ya decidió que estas no sirven, así que guardarlas
      // sería quedarse con el documento de identidad de alguien sin motivo.
      await this.documents.deleteDocuments([row.frontUrl, row.backUrl]);
      const reason = verificationReason("RECHAZADO_POR_ADMIN", {
        slots: slotsOf(TYPE_TO_KIND[row.type]),
      });
      updated = await this.prisma.documentVerification.update({
        where: { id: row.id },
        data: {
          status: DocumentVerificationStatus.REJECTED,
          frontUrl: null,
          backUrl: null,
          expiresAt: null,
          declared: Prisma.JsonNull,
          checks: Prisma.JsonNull,
          analysisStatus: DocumentAnalysisStatus.NOT_REQUESTED,
          analysisTokenHash: null,
          analysisError: null,
          reasonCodes: [reason.code],
          retakeSlots: reason.slots,
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
      await this.clearDocumentFacts(row.userId, row.type);
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
   * Recalcula User.verificationStatus a partir del email, el teléfono y el
   * DNI. Se llama cada vez que algo de eso cambia.
   *
   * ── Por qué la licencia no cuenta ────────────────────────────────────────
   * Verificar una cuenta es probar QUIÉN ES la persona, y eso lo prueba el
   * DNI. Una licencia prueba que además puede manejar, que es otra cosa: quien
   * solo alquila su auto no tiene por qué tener una, y exigírsela lo dejaba
   * sin poder publicar por un documento que no le hace falta.
   *
   * Lo que la licencia gobierna es `RequireDrivingEligibility`, que es el
   * control que corre sobre reservar un auto.
   *
   * Un documento rechazado por un admin deja la cuenta REJECTED hasta que se
   * reenvíe: es la señal de que alguien miró y dijo que no.
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
    const dniApproved = dni?.status === DocumentVerificationStatus.APPROVED;

    let next: VerificationStatus;
    if (dniApproved && emailVerified && (!phoneRequired || phoneVerified)) {
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
   * automática como en la del admin. Un documento sin número no se puede
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
   * Copia a la cuenta lo que su dueño declaró de este documento, ahora que la
   * foto lo corroboró.
   *
   * ESTÁ DUPLICADO A PROPÓSITO. Los mismos datos viven en la fila de
   * DocumentVerification; se copian al usuario porque son los que se consultan
   * en CADA pedido para saber qué puede hacer, y JwtStrategy ya trae el usuario
   * entero. Tenerlos acá convierte ese control en cero consultas extra, y el
   * único precio es acordarse de limpiarlos cuando el documento se revoca —que
   * es lo que hace `clearDocumentFacts`.
   */
  private async applyDeclaredToUser(
    userId: string,
    type: VerifiedDocumentType,
    declared: DeclaredDocumentData,
  ): Promise<void> {
    const data =
      type === VerifiedDocumentType.LICENSE
        ? {
            licenseExpiresAt: declared.expiresAt,
            licenseClass: declared.licenseClass ?? null,
            licenseIssuedAt: declared.issuedAt ?? null,
            licenseBeginnerUntil: declared.beginnerUntil ?? null,
          }
        : { dniExpiresAt: declared.expiresAt };

    await this.prisma.user.update({ where: { id: userId }, data });
  }

  /** Lo que la cuenta deja de saber cuando un documento se revoca. */
  private async clearDocumentFacts(
    userId: string,
    type: VerifiedDocumentType,
  ): Promise<void> {
    const data =
      type === VerifiedDocumentType.LICENSE
        ? {
            licenseExpiresAt: null,
            licenseClass: null,
            licenseIssuedAt: null,
            licenseBeginnerUntil: null,
          }
        : { dniExpiresAt: null };

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

    // El DOMINIO DE PRODUCCIÓN antes que la URL del deploy, y el orden importa
    // más de lo que parece.
    //
    // VERCEL_URL es la URL única de ESTE deploy
    // (proyecto-a1b2c3-org.vercel.app), y la Deployment Protection de Vercel
    // —que viene activada por defecto— la protege con su propio login. Un
    // pedido sin la cookie de sesión de Vercel recibe 401 "Protected
    // deployment" ANTES de llegar a este código, así que el aviso de la API de
    // lectura moría ahí: el documento se leía bien y el resultado se perdía.
    // VERCEL_PROJECT_PRODUCTION_URL es el dominio estable del proyecto, que en
    // producción sí es público.
    const produccion = this.config
      .get<string>("VERCEL_PROJECT_PRODUCTION_URL")
      ?.trim();
    if (produccion) return `https://${produccion.replace(/\/+$/, "")}`;

    const vercel = this.config.get<string>("VERCEL_URL")?.trim();
    if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;

    // Corriendo en la máquina de alguien, la URL propia se puede deducir y no
    // hace falta que nadie la configure: es localhost y el puerto en el que
    // estamos escuchando. Sin esto, levantar el proyecto entero en local dejaba
    // la lectura automática apagada por una variable que no era evidente que
    // faltara — y el síntoma era silencioso.
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
   * quedar documentos huérfanos, y es el único momento en que se borran fotos
   * que el usuario no pidió borrar — porque acaba de mandar otras.
   *
   * `documentNumber` se guarda del DNI declarado en el perfil —en Argentina el
   * número de licencia ES el del DNI— y es lo que después usa el control
   * antifraude para no aprobar la misma identidad en dos cuentas. Sale del
   * perfil y no de la foto a propósito: es un dato declarado que la foto
   * corrobora, como todos los demás.
   */
  private async persistSubmission(
    user: User,
    type: VerifiedDocumentType,
    existing: DocumentVerification | null,
    urls: { frontUrl: string; backUrl: string },
    declared: DeclaredDocumentData,
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
      expiresAt: declared.expiresAt,
      declared: serializeDeclared(declared),
      matchReport: Prisma.JsonNull,
      reasonCodes: [],
      retakeSlots: [],
      // Fotos nuevas, análisis nuevo: lo que se había cruzado sobre las
      // anteriores no describe a estas. El token del análisis viejo se borra
      // acá, y eso es lo que hace que su aviso —si llega tarde— no se aplique.
      checks: Prisma.JsonNull,
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
        action: reason.action,
        missing,
      });
    }
  }

  /**
   * Valida y convierte lo que la persona declaró de este documento.
   *
   * Qué es obligatorio depende del tipo, y eso no se puede poner en el DTO
   * (el tipo viene en la URL, no en el body). El error nombra los campos que
   * faltan con el nombre del formulario, así el front marca el input exacto en
   * vez de mostrar "faltan datos".
   */
  private parseDeclared(
    type: VerifiedDocumentType,
    dto: SubmitDocumentDto,
  ): DeclaredDocumentData {
    const missing = REQUIRED_DECLARED_FIELDS[type]
      .filter(({ field }) => dto[field] === undefined || dto[field] === null)
      .map(({ field }) => field as string);

    // El fin del período de principiante solo se pide si la persona dijo que
    // su licencia lo tiene: pedirlo siempre sería pedir una fecha que no
    // existe en la mayoría de las licencias.
    if (
      type === VerifiedDocumentType.LICENSE &&
      dto.isBeginner === true &&
      !dto.beginnerUntil
    ) {
      missing.push("beginnerUntil");
    }

    if (missing.length > 0) {
      const reason = verificationReason("DATOS_DEL_DOCUMENTO_FALTANTES", {
        missing: missing.map(
          (field) =>
            REQUIRED_DECLARED_FIELDS[type].find((f) => f.field === field)
              ?.label ?? field,
        ),
      });
      throw new BadRequestException({
        statusCode: 400,
        code: reason.code,
        message: reason.message,
        action: reason.action,
        missing,
      });
    }

    const expiresAt = parseFecha(dto.expiresAt);
    if (!expiresAt) {
      throw new BadRequestException({
        statusCode: 400,
        code: "DECLARED_DATE_INVALID",
        message: "La fecha de vencimiento no es una fecha real.",
        missing: ["expiresAt"],
      });
    }

    if (type === VerifiedDocumentType.DNI) {
      return { expiresAt };
    }

    const issuedAt = parseFecha(dto.issuedAt);
    if (!issuedAt) {
      throw new BadRequestException({
        statusCode: 400,
        code: "DECLARED_DATE_INVALID",
        message: "La fecha de otorgamiento no es una fecha real.",
        missing: ["issuedAt"],
      });
    }
    // Una licencia no puede vencer antes de otorgarse. Es el único control de
    // coherencia entre dos fechas declaradas, y atrapa el error de carga más
    // común: escribir las dos al revés.
    if (issuedAt > expiresAt) {
      throw new BadRequestException({
        statusCode: 400,
        code: "DECLARED_DATES_INCONSISTENT",
        message:
          "La fecha de otorgamiento de la licencia es posterior a la de " +
          "vencimiento. Revisá que no estén invertidas.",
        missing: ["issuedAt", "expiresAt"],
      });
    }

    const beginnerUntil = dto.isBeginner ? parseFecha(dto.beginnerUntil) : null;
    if (dto.isBeginner && !beginnerUntil) {
      throw new BadRequestException({
        statusCode: 400,
        code: "DECLARED_DATE_INVALID",
        message:
          "La fecha de fin del período de principiante no es una fecha real.",
        missing: ["beginnerUntil"],
      });
    }

    return {
      expiresAt,
      issuedAt,
      licenseClass: dto.licenseClass?.trim().toUpperCase() ?? null,
      isBeginner: Boolean(dto.isBeginner),
      beginnerUntil,
    };
  }

  toPublicView(row: DocumentVerification): DocumentVerificationView {
    const kind = TYPE_TO_KIND[row.type];
    const reasons = readReasons(row.matchReport);
    const retakeSlots = (row.retakeSlots ?? []) as DocumentSlot[];

    return {
      id: row.id,
      type: row.type,
      status: row.status,
      reasons,
      nextAction: nextAction(row, reasons),
      documents: { front: Boolean(row.frontUrl), back: Boolean(row.backUrl) },
      photos: (["front", "back"] as const).map((side) => {
        const slot = slotFor(kind, side);
        return {
          slot,
          side,
          present: Boolean(side === "front" ? row.frontUrl : row.backUrl),
          mustRetake: retakeSlots.includes(slot),
        };
      }),
      retakeSlots,
      declared: declaredView(row),
      // Reenviar fotos se puede SIEMPRE salvo que ya esté aprobado. Con una
      // revisión manual pendiente también: mandar fotos nuevas la reemplaza.
      canResubmit: row.status !== DocumentVerificationStatus.APPROVED,
      // Pedir revisión tiene sentido sobre un documento enviado, todavía sin
      // resolver y con las fotos guardadas. Si ya está pedida, no se repite.
      canRequestManualReview:
        (row.status === DocumentVerificationStatus.PENDING ||
          row.status === DocumentVerificationStatus.FAILED) &&
        Boolean(row.frontUrl) &&
        Boolean(row.backUrl),
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
 *   · que el análisis NO SE HAYA HECHO — que haya fallado antes de empezar
 *     (FAILED) o que se haya perdido en el camino. Si está QUEUED hay uno
 *     corriendo y pedir otro duplicaría el trabajo del servicio de lectura,
 *     que es justamente el recurso escaso; si está DONE ya hay un veredicto y
 *     volver a analizar LAS MISMAS fotos daría lo mismo;
 *   · que las fotos sigan guardadas — un documento rechazado ya no las tiene;
 *   · que el documento no esté resuelto — aprobado o rechazado, la lectura ya
 *     no cambia nada.
 */
function canRetryAnalysis(row: DocumentVerification): boolean {
  return (
    (row.analysisStatus === DocumentAnalysisStatus.FAILED ||
      analisisAbandonado(row)) &&
    Boolean(row.frontUrl) &&
    Boolean(row.backUrl) &&
    row.status !== DocumentVerificationStatus.APPROVED &&
    row.status !== DocumentVerificationStatus.REJECTED
  );
}

/**
 * El orden en que importan las acciones cuando hay varios motivos a la vez.
 *
 * Una foto ilegible y un dato que no coincide pueden aparecer juntos, y el
 * front tiene que elegir UN botón. Gana lo que desbloquea más rápido: repetir
 * una foto es un toque, corregir el perfil son tres pantallas, y esperar a un
 * admin son días. Presentar primero lo más lento sería mandar a esperar a
 * alguien que podía resolverlo solo.
 */
const PRIORIDAD_DE_ACCION: ReasonAction[] = [
  "RETAKE_PHOTO",
  "FIX_DECLARED_DATA",
  "FIX_PROFILE",
  "USE_VALID_DOCUMENT",
  "REQUEST_REVIEW",
  "CONTACT_SUPPORT",
  "WAIT",
];

/** Qué tiene que hacer la persona ahora, en una sola palabra. */
function nextAction(
  row: DocumentVerification,
  reasons: VerificationReason[],
): ReasonAction | null {
  if (row.status === DocumentVerificationStatus.APPROVED) return null;
  if (row.status === DocumentVerificationStatus.MANUAL_REVIEW) return "WAIT";
  if (
    row.status === DocumentVerificationStatus.PENDING &&
    row.analysisStatus === DocumentAnalysisStatus.QUEUED
  ) {
    return "WAIT";
  }
  if (row.status === DocumentVerificationStatus.PENDING && !reasons.length) {
    // El análisis no se pudo hacer: la salida es esperar a un admin (o
    // reintentar, que el front ya sabe por analysis.canRetry).
    return "WAIT";
  }

  for (const accion of PRIORIDAD_DE_ACCION) {
    if (reasons.some((r) => r.action === accion)) return accion;
  }
  return null;
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

/** Cómo se guarda lo declarado en la columna Json. */
function serializeDeclared(
  declared: DeclaredDocumentData,
): Prisma.InputJsonValue {
  return {
    expiresAt: declared.expiresAt.toISOString(),
    issuedAt: declared.issuedAt?.toISOString() ?? null,
    licenseClass: declared.licenseClass ?? null,
    isBeginner: declared.isBeginner ?? null,
    beginnerUntil: declared.beginnerUntil?.toISOString() ?? null,
  };
}

/**
 * Lo declarado, recuperado de la fila.
 *
 * Devuelve null cuando no hay: es el caso de las filas anteriores a este
 * cambio, y quien llama decide qué hacer (no se puede cruzar contra nada, así
 * que no se puede aprobar sola).
 *
 * `expiresAt` sale de la COLUMNA y no del JSON porque es la columna la que se
 * mantiene al día: un admin puede corregirla sin tocar el declarado.
 */
function readDeclared(row: DocumentVerification): DeclaredDocumentData | null {
  const raw = row.declared as Record<string, unknown> | null;
  if (!raw) return null;

  const expiresAt = row.expiresAt ?? aDate(raw.expiresAt);
  if (!expiresAt) return null;

  return {
    expiresAt,
    issuedAt: aDate(raw.issuedAt),
    licenseClass:
      typeof raw.licenseClass === "string" ? raw.licenseClass : null,
    isBeginner: raw.isBeginner === true,
    beginnerUntil: aDate(raw.beginnerUntil),
  };
}

/** Lo declarado, como se le devuelve al front: fechas en YYYY-MM-DD. */
function declaredView(row: DocumentVerification): DeclaredView | null {
  const declared = readDeclared(row);
  if (!declared) return null;
  return {
    expiresAt: isoCorto(declared.expiresAt),
    issuedAt: declared.issuedAt ? isoCorto(declared.issuedAt) : null,
    licenseClass: declared.licenseClass ?? null,
    isBeginner: declared.isBeginner ?? null,
    beginnerUntil: declared.beginnerUntil
      ? isoCorto(declared.beginnerUntil)
      : null,
  };
}

/**
 * "2026-10-28" → Date, en UTC A MEDIODÍA.
 *
 * A mediodía y no a medianoche, que es lo que hace `new Date("2026-10-28")`.
 * Una fecha sin hora guardada a medianoche UTC, leída en Argentina (UTC-3),
 * cae el día anterior a las 21:00: una licencia que vence el 28 figuraría
 * venciendo el 27. El mediodía deja doce horas de margen para cada lado, que
 * cubre cualquier zona horaria del mundo.
 */
function parseFecha(iso: string | undefined | null): Date | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const fecha = new Date(`${iso}T12:00:00.000Z`);
  if (Number.isNaN(fecha.getTime())) return null;
  // Round-trip: descarta fechas que no existen (2025-02-31 se convertiría en
  // marzo sin avisar).
  return fecha.toISOString().slice(0, 10) === iso ? fecha : null;
}

/**
 * Las fechas guardadas en JSON vuelven como texto ISO, no como Date: Prisma
 * serializa la columna Json tal cual y no reconstruye tipos.
 */
function aDate(valor: unknown): Date | null {
  if (!valor) return null;
  if (valor instanceof Date) return valor;
  if (typeof valor !== "string") return null;
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function isoCorto(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
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
    return (matchReport as { reasons: VerificationReason[] }).reasons
      .filter((reason) => reason && typeof reason.code === "string")
      .map((reason) => ({
        ...reason,
        // Las filas guardadas antes de este cambio no tienen `action` ni
        // `slots`. Se completan para que el front reciba SIEMPRE la misma
        // forma y no tenga que preguntarse si este motivo es de los de antes.
        // El respaldo es REQUEST_REVIEW porque es la salida que siempre
        // existe: sobre un motivo viejo no sabemos si alcanzaba con repetir
        // una foto, y mandar a repetir una foto que no era el problema es
        // peor que ofrecer que lo mire alguien.
        action: reason.action ?? ("REQUEST_REVIEW" as ReasonAction),
        slots: reason.slots ?? ([] as DocumentSlot[]),
      }));
  }
  return [];
}
