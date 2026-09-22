import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DocumentAnalysisStatus,
  DocumentVerificationStatus,
  Prisma,
  VehicleVerificationStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CloudinaryService } from "../media/cloudinary.service";
import { AuditLogService } from "../common/services/audit-log.service";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cuántas filas de CADA categoría se procesan por corrida.
 *
 * Cada documento son dos llamadas a Cloudinary en serie, y la función corre
 * con un límite de 60 segundos (vercel.json). Sin tope, la primera corrida
 * contra una base con meses de fotos acumuladas no termina nunca: la plataforma
 * la mata a la mitad y no queda ni el log de cuánto hizo. Lo que no entra se
 * cuenta y se loguea, y lo toma la corrida siguiente.
 */
export const DOCUMENT_BATCH_SIZE = 200;

/**
 * Los contadores del limitador son filas diminutas que se borran con un solo
 * DELETE, sin ninguna llamada externa, y se crean mucho más rápido que los
 * documentos (una por clave y por ventana). Con el tope de los documentos no
 * alcanzarían a vaciarse nunca.
 */
export const RATE_LIMIT_BATCH_SIZE = 5000;

/**
 * Tiempo máximo que se le dedica a una corrida antes de dejar de empezar
 * documentos nuevos. Deja margen contra los 60 segundos de la función para que
 * lo ya hecho se loguee y se devuelva: una corrida cortada por la plataforma
 * hizo su trabajo igual —cada fila se guarda sola— pero no dice cuánto.
 */
export const RUN_TIME_BUDGET_MS = 40_000;

/**
 * Un contador sin movimiento en dos días ya no está contando nada: todas las
 * ventanas del limitador son más cortas que eso. Si alguna vez se agrega una
 * ventana o un bloqueo más largo, este plazo tiene que subir con ella; si no,
 * borrar el contador sería perdonarle los intentos a quien los venía haciendo.
 */
const RATE_LIMIT_BUCKET_IDLE_MS = 2 * DAY_MS;

/**
 * Cuánto tiempo después de pedido un análisis se lo considera todavía en
 * curso. El flujo de verificación ya lo da por perdido a los diez minutos (ver
 * `analisisAbandonado`); un día es un margen holgado a propósito, porque
 * equivocarse para este lado cuesta un día más de guardar una foto, y para el
 * otro, borrarle las fotos a un análisis que está por bajarlas.
 */
const ANALYSIS_IN_FLIGHT_MS = DAY_MS;

/**
 * Nada se purga antes de un día, diga lo que diga la variable. Un "0" o un
 * valor mal escrito no puede convertirse en "borrar ya": una persona con un
 * documento FAILED puede estar por reenviarlo reutilizando la foto que salió
 * bien, y un admin puede estar mirando uno recién aprobado.
 */
const MIN_RETENTION_DAYS = 1;

const RETENTION_DAYS_DEFAULTS = {
  IDENTITY_PHOTO_RETENTION_DAYS: 30,
  ABANDONED_DOCUMENT_RETENTION_DAYS: 90,
  VEHICLE_DOCUMENT_RETENTION_DAYS: 180,
} as const;

type RetentionDaysKey = keyof typeof RETENTION_DAYS_DEFAULTS;

export type RetentionCategory =
  | "identityApproved"
  | "identityAbandoned"
  | "identityRejected"
  | "vehicleApproved"
  | "vehicleRejected"
  | "rateLimitBuckets";

/** Lo que pasó con una categoría en una corrida. */
export interface RetentionCategoryResult {
  /** Filas purgadas (o contadores borrados) en esta corrida. */
  purged: number;
  /**
   * Filas que no se pudieron purgar porque algún archivo no se pudo borrar.
   * Quedan exactamente como estaban y se reintentan en la próxima corrida.
   */
  failed: number;
  /**
   * Filas que cambiaron mientras se las procesaba —la persona reenvió, pidió
   * revisión— y por eso no se marcaron. Se dejan con lo que tengan ahora.
   */
  skipped: number;
  /**
   * Filas vencidas que no se llegaron a procesar: no entraron en el lote, se
   * acabó el tiempo de la corrida o Cloudinary no está configurado. Las toma
   * la corrida siguiente.
   */
  deferred: number;
}

export interface RetentionRunResult {
  identityDocumentsPurged: number;
  vehicleDocumentsPurged: number;
  rateLimitBucketsDeleted: number;
  identityDocumentsFailed: number;
  vehicleDocumentsFailed: number;
  /** Total de filas vencidas que quedaron para la próxima corrida. */
  deferred: number;
  categories: Record<RetentionCategory, RetentionCategoryResult>;
  /**
   * Categorías que no se pudieron ni consultar (la base falló, la tabla no
   * existe todavía en ese entorno). Las demás se procesaron igual.
   */
  categoriesWithErrors: RetentionCategory[];
  /** Cloudinary no está configurado: esta corrida no tocó ninguna foto. */
  storageUnavailable: boolean;
}

/** Cómo se purga una categoría de filas con fotos. */
interface PhotoPurgeSpec<Row extends { id: string }> {
  category: RetentionCategory;
  /** Cómo se nombra en los logs, en plural. */
  label: string;
  count(): Promise<number>;
  fetch(take: number): Promise<Row[]>;
  photos(row: Row): (string | null)[];
  /**
   * Borra las URLs de la fila SOLO si sigue como se la leyó. Devuelve si la
   * encontró.
   */
  markPurged(row: Row): Promise<boolean>;
  audit(row: Row, filesDeleted: number): Promise<unknown>;
}

type RowOutcome = "purged" | "failed" | "skipped";

const IDENTITY_SELECT = {
  id: true,
  userId: true,
  type: true,
  status: true,
  frontUrl: true,
  backUrl: true,
  updatedAt: true,
} satisfies Prisma.DocumentVerificationSelect;

type IdentityRow = Prisma.DocumentVerificationGetPayload<{
  select: typeof IDENTITY_SELECT;
}>;

const VEHICLE_SELECT = {
  id: true,
  ownerId: true,
  vehicleId: true,
  status: true,
  cedulaFrontUrl: true,
  cedulaBackUrl: true,
  updatedAt: true,
} satisfies Prisma.VehicleVerificationSelect;

type VehicleRow = Prisma.VehicleVerificationGetPayload<{
  select: typeof VEHICLE_SELECT;
}>;

/**
 * CONSERVACIÓN DE DATOS: LAS FOTOS DE DOCUMENTOS SE BORRAN CUANDO YA NO SIRVEN
 *
 * La Ley 25.326 pide destruir los datos personales cuando dejan de ser
 * necesarios para lo que se recolectaron. Las fotos del DNI, de la licencia y
 * de la cédula del auto son lo más sensible que guardamos, y se recolectan para
 * UNA cosa: que alguien —la lectura automática o un admin— compruebe que lo
 * declarado es cierto. Una vez que eso pasó, la foto no tiene otro uso.
 *
 * ── Se va la imagen, queda la fila ──────────────────────────────────────────
 * La fila de la verificación NO se borra: es la constancia de que la
 * verificación se hizo, cuándo, con qué resultado y contra qué datos
 * declarados. Es parte del registro comercial de la operación, que se conserva
 * diez años (CCyC art. 328), y es lo que permite contestar "¿esta persona
 * estaba verificada cuando alquiló?". La imagen no suma nada a esa constancia:
 * es un dato personal más, y el peor de todos para que se filtre. Por eso se
 * borra el archivo de Cloudinary, se ponen las URLs en null y queda
 * `photosPurgedAt` como marca de que se borró a propósito y no se perdió.
 *
 * ── Primero el archivo, después la fila ─────────────────────────────────────
 * Si el archivo no se puede borrar, la fila queda EXACTAMENTE como estaba y se
 * reintenta en la próxima corrida. Al revés —borrar la URL y después intentar
 * el archivo— un fallo de Cloudinary dejaría el documento de alguien en el
 * storage sin ningún puntero para encontrarlo: el peor resultado posible para
 * un trabajo que existe para borrar datos personales.
 *
 * Por eso mismo es idempotente: si la corrida se corta entre borrar el archivo
 * y actualizar la fila, la siguiente vuelve a pedir el borrado, Cloudinary
 * contesta que no lo encuentra —que para borrar es el resultado buscado— y la
 * fila se termina de marcar.
 *
 * ── Un fallo no frena al resto ──────────────────────────────────────────────
 * Cada fila se procesa por su cuenta: una foto que no se puede borrar suma un
 * fallo y se sigue con la siguiente. Y cada categoría también: si la tabla de
 * vehículos no existe todavía en un entorno, las fotos de identidad se purgan
 * igual.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
  ) {}

  async purgeExpired(now: Date = new Date()): Promise<RetentionRunResult> {
    const deadline = Date.now() + RUN_TIME_BUDGET_MS;
    const storageAvailable = this.storageConfigured();
    if (!storageAvailable) {
      this.logger.warn(
        "Cloudinary no está configurado: esta corrida no borra ninguna foto. " +
          "Los documentos vencidos quedan esperando y se cuentan como diferidos.",
      );
    }

    const categories = {} as Record<RetentionCategory, RetentionCategoryResult>;
    const categoriesWithErrors: RetentionCategory[] = [];

    const photoRuns = [
      this.photoRun(this.identityApprovedSpec(now)),
      this.photoRun(this.identityAbandonedSpec(now)),
      this.photoRun(this.identityRejectedSpec(now)),
      this.photoRun(this.vehicleApprovedSpec(now)),
      this.photoRun(this.vehicleRejectedSpec(now)),
    ];
    for (const spec of photoRuns) {
      try {
        categories[spec.category] = await spec.run(storageAvailable, deadline);
      } catch (error) {
        categoriesWithErrors.push(spec.category);
        categories[spec.category] = emptyResult();
        this.logger.error(
          `No se pudieron consultar los ${spec.label}: ${errorMessage(error)}. ` +
            "Se siguió con las demás categorías.",
        );
      }
    }

    try {
      categories.rateLimitBuckets = await this.deleteIdleRateLimitBuckets(now);
    } catch (error) {
      categoriesWithErrors.push("rateLimitBuckets");
      categories.rateLimitBuckets = emptyResult();
      this.logger.error(
        `No se pudieron borrar los contadores del limitador: ${errorMessage(error)}`,
      );
    }

    const result: RetentionRunResult = {
      identityDocumentsPurged:
        categories.identityApproved.purged +
        categories.identityAbandoned.purged +
        categories.identityRejected.purged,
      vehicleDocumentsPurged:
        categories.vehicleApproved.purged + categories.vehicleRejected.purged,
      rateLimitBucketsDeleted: categories.rateLimitBuckets.purged,
      identityDocumentsFailed:
        categories.identityApproved.failed +
        categories.identityAbandoned.failed +
        categories.identityRejected.failed,
      vehicleDocumentsFailed:
        categories.vehicleApproved.failed + categories.vehicleRejected.failed,
      deferred: Object.values(categories).reduce((n, c) => n + c.deferred, 0),
      categories,
      categoriesWithErrors,
      storageUnavailable: !storageAvailable,
    };

    this.logger.log(
      `Conservación de datos: ${result.identityDocumentsPurged} documentos de ` +
        `identidad y ${result.vehicleDocumentsPurged} cédulas purgados, ` +
        `${result.rateLimitBucketsDeleted} contadores borrados; ` +
        `${result.identityDocumentsFailed + result.vehicleDocumentsFailed} ` +
        `fallaron y ${result.deferred} quedan para la próxima corrida.`,
    );
    return result;
  }

  // ── Documentos de identidad ────────────────────────────────────────────

  /**
   * Documentos APROBADOS cuya revisión tiene más de
   * IDENTITY_PHOTO_RETENTION_DAYS. Se cuenta desde `reviewedAt`, que es cuando
   * alguien terminó de mirar la foto; si falta, desde `updatedAt`, que nunca es
   * anterior y por lo tanto solo puede demorar el borrado, nunca adelantarlo.
   */
  private identityApprovedSpec(now: Date): PhotoPurgeSpec<IdentityRow> {
    const days = this.retentionDays("IDENTITY_PHOTO_RETENTION_DAYS");
    const cutoff = daysBefore(now, days);
    return this.identitySpec({
      category: "identityApproved",
      label: "documentos de identidad aprobados",
      reason: "approved",
      retentionDays: days,
      now,
      where: {
        status: DocumentVerificationStatus.APPROVED,
        AND: [
          IDENTITY_HAS_PHOTOS,
          reviewedBefore(cutoff),
          analysisNotInFlight(now),
        ],
      },
    });
  }

  /**
   * Documentos que alguien empezó y dejó: PENDING o FAILED sin movimiento en
   * ABANDONED_DOCUMENT_RETENTION_DAYS. La persona no los terminó, así que las
   * fotos no llegaron a servir para nada y no hay motivo para seguir
   * teniéndolas. Si vuelve, saca fotos nuevas.
   *
   * MANUAL_REVIEW queda afuera por viejo que sea: ahí la persona hizo todo lo
   * que le tocaba y está esperando a un admin, que necesita las fotos para
   * decidir. Borrárselas sería castigarla por nuestra demora.
   */
  private identityAbandonedSpec(now: Date): PhotoPurgeSpec<IdentityRow> {
    const days = this.retentionDays("ABANDONED_DOCUMENT_RETENTION_DAYS");
    const cutoff = daysBefore(now, days);
    return this.identitySpec({
      category: "identityAbandoned",
      label: "documentos de identidad abandonados",
      reason: "abandoned",
      retentionDays: days,
      now,
      where: {
        status: {
          in: [
            DocumentVerificationStatus.PENDING,
            DocumentVerificationStatus.FAILED,
          ],
        },
        updatedAt: { lt: cutoff },
        AND: [IDENTITY_HAS_PHOTOS, analysisNotInFlight(now)],
      },
    });
  }

  /**
   * Documentos RECHAZADOS que conservan fotos, a cualquier edad. El rechazo ya
   * borra los archivos; si una fila rechazada todavía tiene URLs es porque ese
   * borrado no llegó a hacerse, y no hay ningún plazo que esperar.
   */
  private identityRejectedSpec(now: Date): PhotoPurgeSpec<IdentityRow> {
    return this.identitySpec({
      category: "identityRejected",
      label: "documentos de identidad rechazados con fotos",
      reason: "rejected",
      retentionDays: null,
      now,
      where: {
        status: DocumentVerificationStatus.REJECTED,
        AND: [IDENTITY_HAS_PHOTOS],
      },
    });
  }

  /**
   * Lo común a las tres categorías de identidad.
   *
   * NO SE FILTRA POR `photosPurgedAt: null`
   * Lo que decide si hay algo que purgar es que haya fotos, no la marca: una
   * fila purgada ya no tiene URLs y no vuelve a entrar, así que el trabajo es
   * idempotente sin mirarla. Y filtrar por la marca sería un error: reenviar un
   * documento pisa las URLs pero no la limpia, así que las fotos nuevas de
   * alguien a quien ya se le purgaron las viejas quedarían guardadas para
   * siempre.
   */
  private identitySpec(input: {
    category: RetentionCategory;
    label: string;
    reason: "approved" | "abandoned" | "rejected";
    retentionDays: number | null;
    now: Date;
    where: Prisma.DocumentVerificationWhereInput;
  }): PhotoPurgeSpec<IdentityRow> {
    const { where, now } = input;
    return {
      category: input.category,
      label: input.label,
      count: () => this.prisma.documentVerification.count({ where }),
      fetch: (take) =>
        this.prisma.documentVerification.findMany({
          where,
          select: IDENTITY_SELECT,
          // Lo más vencido primero: si no entra todo, lo que espera es lo que
          // menos tiempo lleva de más.
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take,
        }),
      photos: (row) => [row.frontUrl, row.backUrl],
      markPurged: async (row) => {
        // La condición es la fila tal como se la leyó. Si entre la lectura y
        // acá la persona reenvió el documento o pidió revisión, `updatedAt`
        // cambió y esto no toca nada: las URLs que tenga ahora no son las que
        // se borraron.
        const { count } = await this.prisma.documentVerification.updateMany({
          where: {
            id: row.id,
            updatedAt: row.updatedAt,
            frontUrl: row.frontUrl,
            backUrl: row.backUrl,
          },
          data: { frontUrl: null, backUrl: null, photosPurgedAt: now },
        });
        return count === 1;
      },
      // Sin URLs, sin número de documento, sin nada de lo declarado: el
      // registro dice QUÉ se borró y POR QUÉ regla, no de quién era la foto
      // más allá del id que ya está en targetUserId.
      audit: (row, filesDeleted) =>
        this.auditLog.create({
          targetUserId: row.userId,
          action: "retention.identity_photos_purged",
          entityType: "DocumentVerification",
          entityId: row.id,
          metadata: {
            reason: input.reason,
            documentType: row.type,
            status: row.status,
            retentionDays: input.retentionDays,
            filesDeleted,
          },
        }),
    };
  }

  // ── Cédulas de vehículos ───────────────────────────────────────────────

  /**
   * Cédulas de verificaciones APROBADAS hace más de
   * VEHICLE_DOCUMENT_RETENTION_DAYS, contando igual que en identidad: desde la
   * revisión, o desde `updatedAt` si falta.
   */
  private vehicleApprovedSpec(now: Date): PhotoPurgeSpec<VehicleRow> {
    const days = this.retentionDays("VEHICLE_DOCUMENT_RETENTION_DAYS");
    const cutoff = daysBefore(now, days);
    return this.vehicleSpec({
      category: "vehicleApproved",
      label: "cédulas de vehículos aprobados",
      reason: "approved",
      retentionDays: days,
      now,
      where: {
        status: VehicleVerificationStatus.APPROVED,
        AND: [VEHICLE_HAS_PHOTOS, reviewedBefore(cutoff)],
      },
    });
  }

  /**
   * Cédulas de verificaciones RECHAZADAS que conservan fotos, a cualquier
   * edad: el rechazo las borra, y si quedaron es porque ese borrado falló.
   */
  private vehicleRejectedSpec(now: Date): PhotoPurgeSpec<VehicleRow> {
    return this.vehicleSpec({
      category: "vehicleRejected",
      label: "cédulas de vehículos rechazados con fotos",
      reason: "rejected",
      retentionDays: null,
      now,
      where: {
        status: VehicleVerificationStatus.REJECTED,
        AND: [VEHICLE_HAS_PHOTOS],
      },
    });
  }

  /** Lo mismo que identitySpec, con los campos de la cédula. */
  private vehicleSpec(input: {
    category: RetentionCategory;
    label: string;
    reason: "approved" | "rejected";
    retentionDays: number | null;
    now: Date;
    where: Prisma.VehicleVerificationWhereInput;
  }): PhotoPurgeSpec<VehicleRow> {
    const { where, now } = input;
    return {
      category: input.category,
      label: input.label,
      count: () => this.prisma.vehicleVerification.count({ where }),
      fetch: (take) =>
        this.prisma.vehicleVerification.findMany({
          where,
          select: VEHICLE_SELECT,
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take,
        }),
      photos: (row) => [row.cedulaFrontUrl, row.cedulaBackUrl],
      markPurged: async (row) => {
        const { count } = await this.prisma.vehicleVerification.updateMany({
          where: {
            id: row.id,
            updatedAt: row.updatedAt,
            cedulaFrontUrl: row.cedulaFrontUrl,
            cedulaBackUrl: row.cedulaBackUrl,
          },
          data: {
            cedulaFrontUrl: null,
            cedulaBackUrl: null,
            photosPurgedAt: now,
          },
        });
        return count === 1;
      },
      audit: (row, filesDeleted) =>
        this.auditLog.create({
          targetUserId: row.ownerId,
          action: "retention.vehicle_photos_purged",
          entityType: "VehicleVerification",
          entityId: row.id,
          metadata: {
            reason: input.reason,
            vehicleId: row.vehicleId,
            status: row.status,
            retentionDays: input.retentionDays,
            filesDeleted,
          },
        }),
    };
  }

  // ── El recorrido común ─────────────────────────────────────────────────

  /**
   * Esconde el tipo de fila detrás de una función, para poder recorrer las
   * categorías de identidad y de vehículos en una sola lista sin que una
   * pueda recibir filas de la otra.
   */
  private photoRun<Row extends { id: string }>(spec: PhotoPurgeSpec<Row>) {
    return {
      category: spec.category,
      label: spec.label,
      run: (storageAvailable: boolean, deadline: number) =>
        this.purgePhotos(spec, storageAvailable, deadline),
    };
  }

  private async purgePhotos<Row extends { id: string }>(
    spec: PhotoPurgeSpec<Row>,
    storageAvailable: boolean,
    deadline: number,
  ): Promise<RetentionCategoryResult> {
    const result = emptyResult();
    const total = await spec.count();
    if (total === 0) return result;

    if (!storageAvailable || Date.now() > deadline) {
      result.deferred = total;
      this.logDeferred(spec.label, total, storageAvailable);
      return result;
    }

    const rows = await spec.fetch(DOCUMENT_BATCH_SIZE);
    let processed = 0;
    for (const row of rows) {
      if (Date.now() > deadline) break;
      processed += 1;
      const outcome = await this.purgeRow(spec, row);
      result[outcome] += 1;
    }

    // Lo que no entró en el lote, más lo que el tiempo no dejó empezar. Se
    // calcula contra el conteo y no contra `rows` para que el log diga cuánto
    // falta de verdad, no solo cuánto quedó de este lote.
    result.deferred = Math.max(0, total - processed);
    if (result.deferred > 0) {
      this.logDeferred(spec.label, result.deferred, storageAvailable);
    }
    if (result.purged || result.failed || result.skipped) {
      this.logger.log(
        `${capitalize(spec.label)}: ${result.purged} purgados, ` +
          `${result.failed} fallaron, ${result.skipped} cambiaron mientras ` +
          "se procesaban.",
      );
    }
    return result;
  }

  private async purgeRow<Row extends { id: string }>(
    spec: PhotoPurgeSpec<Row>,
    row: Row,
  ): Promise<RowOutcome> {
    const urls = spec
      .photos(row)
      .filter((url): url is string => typeof url === "string" && url !== "");

    try {
      // Todas o ninguna: si una de las dos URLs no se puede borrar con
      // seguridad, no se toca tampoco la otra. Así la fila nunca queda
      // apuntando a medio documento.
      if (!urls.every((url) => this.isDeletable(url))) {
        // Sin la URL en el log: es el puntero a un documento de identidad.
        this.logger.error(
          `${capitalize(spec.label)} ${row.id}: una foto no es un archivo de ` +
            "imagen de esta cuenta de Cloudinary y no se puede borrar desde " +
            "acá. La fila queda como está; hace falta mirarla a mano.",
        );
        return "failed";
      }

      // `false` es que Cloudinary no encontró el archivo: ya estaba borrado,
      // típicamente por una corrida anterior que se cortó antes de marcar la
      // fila. Para este trabajo es un éxito. Lo que sí es un fallo es que
      // lance, y eso sale por el catch con la fila intacta.
      for (const url of urls) {
        await this.cloudinary.destroyByUrl(url);
      }

      if (!(await spec.markPurged(row))) {
        this.logger.warn(
          `${capitalize(spec.label)} ${row.id}: la fila cambió mientras se ` +
            "purgaba y se dejó como está.",
        );
        return "skipped";
      }
    } catch (error) {
      this.logger.error(
        `${capitalize(spec.label)} ${row.id}: no se pudieron borrar las ` +
          `fotos (${errorMessage(error)}). La fila queda como estaba y se ` +
          "reintenta en la próxima corrida.",
      );
      return "failed";
    }

    // El registro de auditoría va después y aparte: las fotos ya no están y
    // la fila ya lo dice (`photosPurgedAt`). Que el log de auditoría falle no
    // puede hacer que esto cuente como un fallo y se reintente un borrado que
    // ya ocurrió.
    try {
      await spec.audit(row, urls.length);
    } catch (error) {
      this.logger.error(
        `${capitalize(spec.label)} ${row.id}: fotos purgadas, pero no se ` +
          `pudo registrar en la auditoría (${errorMessage(error)}).`,
      );
    }
    return "purged";
  }

  /**
   * Si una URL guardada se puede borrar sin riesgo de dejar el archivo vivo.
   *
   * Hacen falta dos cosas. Que la URL sea de esta cuenta y con la forma exacta
   * que se sabe interpretar (parseAssetUrl devuelve null ante cualquier duda).
   * Y que sea una IMAGEN: destroy() habla solo con el endpoint de imágenes, así
   * que para un archivo `raw` o `video` Cloudinary contestaría "no lo
   * encuentro", eso se tomaría como "ya estaba borrado", y se perdería el
   * único puntero a un archivo que sigue ahí.
   */
  private isDeletable(url: string): boolean {
    if (!this.cloudinary.parseAssetUrl(url)) return false;
    const cloudName = this.cloudinary.getCloudName();
    return url.startsWith(`https://res.cloudinary.com/${cloudName}/image/`);
  }

  /**
   * Sin credenciales de Cloudinary no se puede borrar nada, y es un problema
   * de configuración, no de una fila: se detecta una vez y se saltean las
   * fotos, en vez de registrar el mismo error doscientas veces por categoría.
   */
  private storageConfigured(): boolean {
    try {
      this.cloudinary.getCloudName();
      return true;
    } catch {
      return false;
    }
  }

  private logDeferred(label: string, count: number, storageAvailable: boolean) {
    this.logger.warn(
      storageAvailable
        ? `${capitalize(label)}: quedan ${count} para la próxima corrida ` +
            `(tope de ${DOCUMENT_BATCH_SIZE} por corrida o se acabó el tiempo).`
        : `${capitalize(label)}: ${count} esperan a que Cloudinary esté configurado.`,
    );
  }

  // ── Contadores del limitador ───────────────────────────────────────────

  /**
   * Borra los contadores sin movimiento en dos días que no tengan un bloqueo
   * vigente. La clave lleva la IP o el id de la persona (ver `by` en
   * SensitiveRateLimit), así que tampoco son filas inocuas, y son solo
   * contadores: una vez vencida la ventana no cuentan nada.
   *
   * Un bloqueo a futuro se respeta aunque el contador esté quieto: borrarlo
   * sería levantarle la sanción a quien la ganó.
   */
  private async deleteIdleRateLimitBuckets(
    now: Date,
  ): Promise<RetentionCategoryResult> {
    const result = emptyResult();
    const where: Prisma.RateLimitBucketWhereInput = {
      updatedAt: { lt: new Date(now.getTime() - RATE_LIMIT_BUCKET_IDLE_MS) },
      OR: [{ blockedUntil: null }, { blockedUntil: { lte: now } }],
    };

    const total = await this.prisma.rateLimitBucket.count({ where });
    if (total === 0) return result;

    const keys = await this.prisma.rateLimitBucket.findMany({
      where,
      select: { key: true },
      orderBy: { updatedAt: "asc" },
      take: RATE_LIMIT_BATCH_SIZE,
    });
    // Se vuelve a pedir la condición en el DELETE: si un contador recibió un
    // pedido entre la lectura y acá, ya no está quieto y tiene que quedar.
    const { count } = await this.prisma.rateLimitBucket.deleteMany({
      where: { AND: [where, { key: { in: keys.map((k) => k.key) } }] },
    });

    result.purged = count;
    result.deferred = Math.max(0, total - keys.length);
    if (result.deferred > 0) {
      this.logger.warn(
        `Contadores del limitador: quedan ${result.deferred} para la próxima ` +
          `corrida (tope de ${RATE_LIMIT_BATCH_SIZE} por corrida).`,
      );
    }
    return result;
  }

  // ── Configuración ──────────────────────────────────────────────────────

  /**
   * Un plazo en días desde el entorno. Vacío usa el de omisión; un valor que
   * no es un número de al menos un día también, pero avisando: un typo en la
   * variable no puede terminar en borrar fotos antes de tiempo.
   */
  private retentionDays(key: RetentionDaysKey): number {
    const fallback = RETENTION_DAYS_DEFAULTS[key];
    const raw = this.config.get<string | number | undefined>(key);
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return fallback;
    }

    const days = Number(raw);
    if (!Number.isFinite(days) || days < MIN_RETENTION_DAYS) {
      this.logger.warn(
        `${key}="${String(raw)}" no es un plazo válido (mínimo ` +
          `${MIN_RETENTION_DAYS} día): se usa el de omisión, ${fallback} días.`,
      );
      return fallback;
    }
    return days;
  }
}

// ── Condiciones compartidas ──────────────────────────────────────────────

const IDENTITY_HAS_PHOTOS: Prisma.DocumentVerificationWhereInput = {
  OR: [{ frontUrl: { not: null } }, { backUrl: { not: null } }],
};

const VEHICLE_HAS_PHOTOS: Prisma.VehicleVerificationWhereInput = {
  OR: [{ cedulaFrontUrl: { not: null } }, { cedulaBackUrl: { not: null } }],
};

/**
 * Revisado antes del corte: por `reviewedAt`, o por `updatedAt` si la fila no
 * lo tiene. Una fila aprobada sin fecha de revisión no puede quedarse con las
 * fotos para siempre solo porque le falta ese dato.
 */
function reviewedBefore(cutoff: Date) {
  return {
    OR: [
      { reviewedAt: { lt: cutoff } },
      { reviewedAt: null, updatedAt: { lt: cutoff } },
    ],
  };
}

/**
 * Que no haya un análisis en curso que esté por bajar las fotos.
 *
 * El criterio es "en curso", no "QUEUED": un análisis QUEUED cuyo aviso nunca
 * volvió —el proceso murió a la mitad, que pasa— no lo está haciendo nadie, y
 * tratarlo como en curso dejaría esas fotos guardadas para siempre. Por eso se
 * respeta solo si se pidió hace menos de ANALYSIS_IN_FLIGHT_MS. Un QUEUED sin
 * fecha de pedido no debería existir; si existe, se lo respeta: sin fecha no
 * hay forma de saber que terminó.
 *
 * Con los plazos por omisión esto casi nunca decide nada, porque pedir un
 * análisis actualiza `updatedAt` y los cortes cuentan meses. Está escrito
 * igual porque es la condición que de verdad importa, y así la garantía no
 * depende de que nadie baje el plazo ni cambie cómo se pide el análisis.
 */
function analysisNotInFlight(now: Date): Prisma.DocumentVerificationWhereInput {
  return {
    OR: [
      { analysisStatus: { not: DocumentAnalysisStatus.QUEUED } },
      {
        analysisRequestedAt: {
          lt: new Date(now.getTime() - ANALYSIS_IN_FLIGHT_MS),
        },
      },
    ],
  };
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

function emptyResult(): RetentionCategoryResult {
  return { purged: 0, failed: 0, skipped: 0, deferred: 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
