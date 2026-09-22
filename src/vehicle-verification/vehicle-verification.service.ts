import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  Vehicle,
  VehicleHolderRelation,
  VehicleVerification,
  VehicleVerificationStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/crypto/encryption.service";
import { AuditLogService } from "../common/services/audit-log.service";
import { USER_SAFE_SELECT } from "../common/constants/prisma-select";
import { assertFound } from "../common/utils/entity.util";
import { SubmitVehicleVerificationDto } from "./dto/submit-vehicle-verification.dto";
import {
  CedulaSide,
  VehicleDocumentsService,
} from "./vehicle-documents.service";
import {
  VehicleReason,
  evaluateVehicleStanding,
  holderNameMatches,
  isExpired,
  isValidDni,
  isoDay,
  maskTail,
  normalizeDni,
  normalizePlate,
  normalizeVin,
  parseDay,
  plateFormat,
  sameDni,
  startOfDayUtc,
  vinProblem,
} from "./vehicle-verification.rules";

/** Quién hizo el pedido y desde dónde: va al registro de auditoría. */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

/** Lo que el dueño ve de la verificación de su auto. Sin URLs, sin datos en claro. */
export interface VehicleVerificationOwnerView {
  vehicleId: string;
  id: string | null;
  status: VehicleVerificationStatus | "NOT_SUBMITTED";
  /**
   * Si en este servidor hace falta la verificación para publicar. Con el flag
   * apagado el front puede ofrecer la verificación sin presentarla como un
   * bloqueo.
   */
  required: boolean;
  /** Si el auto está habilitado HOY (verificación aprobada y seguro vigente). */
  verified: boolean;
  /** Los motivos del último veredicto de un admin. */
  reasonCodes: string[];
  /** Qué impide hoy que el auto esté habilitado, listo para mostrar. */
  reasons: VehicleReason[];
  declared: {
    plate: string;
    chassisNumber: string | null;
    holderRelation: VehicleHolderRelation;
    holderName: string;
    holderDni: string | null;
    insurerName: string | null;
    insurancePolicyNumber: string | null;
    insuranceCoversRental: boolean;
  } | null;
  photos: { front: boolean; back: boolean };
  insuranceExpiresAt: string | null;
  vtvExpiresAt: string | null;
  insuranceValid: boolean;
  insuranceExpiresSoon: boolean;
  vtvValid: boolean | null;
  plateMatchesVehicle: boolean;
  /** Si hoy se acepta un envío (o un reenvío) para este auto. */
  canSubmit: boolean;
  reviewedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** Datos mínimos de la cuenta, para listar sin exponer más de lo necesario. */
const OWNER_LIST_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

type OwnerSummary = Prisma.UserGetPayload<{ select: typeof OWNER_LIST_SELECT }>;

/** Un error de un campo del envío, con el nombre exacto del input. */
interface FieldError {
  code: string;
  field: keyof SubmitVehicleVerificationDto;
  message: string;
  [extra: string]: unknown;
}

/** Lo declarado, ya normalizado y validado, listo para guardar. */
interface ParsedSubmission {
  plate: string;
  chassisNumber: string;
  holderRelation: VehicleHolderRelation;
  holderName: string;
  holderDni: string;
  insurerName: string;
  insurancePolicyNumber: string;
  insuranceExpiresAt: Date;
  vtvExpiresAt: Date | null;
}

/**
 * ¿ESTE AUTO ES DE QUIEN LO PUBLICA?
 *
 * Los dos fraudes más comunes en el alquiler de autos entre particulares son
 * publicar un auto que no es tuyo —subalquilado, prestado o robado— y los
 * "mellizos": un auto con la patente y los papeles clonados de otro legítimo.
 * Los dos se ven igual desde afuera: una foto linda y un precio bueno. Lo que
 * los separa es la cédula de identificación del automotor.
 *
 * ── Qué hace este flujo ─────────────────────────────────────────────────────
 * El dueño sube las dos caras de la cédula y DECLARA lo que dice (patente,
 * chasis, titular) y lo que dice su póliza. Un administrador mira la foto
 * contra lo declarado y aprueba o rechaza. No hay OCR: igual que con los
 * documentos de identidad, el dato lo pone quien lo puede leer con los ojos, y
 * lo que se controla acá es que sea coherente consigo mismo y con la cuenta.
 *
 * ── Qué se controla sin que nadie mire ──────────────────────────────────────
 *   · la patente tiene formato argentino de auto y es la misma que la del auto;
 *   · el chasis es un VIN de 17 caracteres;
 *   · si dice ser el titular, el nombre y el DNI son los de su cuenta (que ya
 *     están verificados contra su DNI); si dice ser autorizado, el titular es
 *     OTRA persona;
 *   · el seguro está vigente y cubre el alquiler.
 *
 * ── El control de fondo: una patente, un dueño ──────────────────────────────
 * Un admin no puede aprobar una patente que ya está aprobada para el auto de
 * otra cuenta: es la huella de un mellizo, o de un mismo auto publicado por
 * dos personas. NO se bloquea al enviar, a propósito: si el mellizo llegó
 * primero, frenar el envío dejaría al dueño legítimo sin forma de llegar a un
 * admin. Se deja pasar a la cola y el admin ve el conflicto al revisar.
 *
 * ── Ciclo de vida ───────────────────────────────────────────────────────────
 *   envío      → PENDING   (fotos guardadas, esperando a un admin)
 *   admin      → APPROVED  (el auto se puede publicar mientras el seguro valga)
 *              → REJECTED  (las fotos se borran; se vuelve a enviar)
 *   reenvío    → PENDING   (reemplaza la fila y borra las fotos anteriores)
 *
 * Hay UNA fila por auto. Por eso un auto aprobado no acepta reenvíos mientras
 * su verificación siga valiendo: el reenvío pisaría la aprobación con un
 * PENDING y el auto quedaría despublicable durante toda la revisión, por un
 * trámite que no hacía falta. Se acepta cuando la aprobación ya no sirve —el
 * seguro venció, la patente del auto cambió, el auto cambió de dueño—, que es
 * cuando el auto ya está bloqueado y no hay nada que perder: eso es renovar.
 */
@Injectable()
export class VehicleVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly auditLog: AuditLogService,
    private readonly documents: VehicleDocumentsService,
  ) {}

  // ── El control que usan publicar y reservar ────────────────────────────

  /**
   * REQUIRE_VEHICLE_VERIFICATION: si hace falta tener el auto verificado para
   * publicarlo y para que lo reserven.
   *
   * Arranca APAGADO, y no por prudencia genérica: el front todavía no tiene
   * las pantallas para subir la cédula. Prenderlo hoy dejaría a todos los
   * dueños sin poder publicar, con un 409 que les pide algo que no tienen
   * dónde hacer. Con el flag apagado el circuito entero funciona —se puede
   * enviar, revisar y aprobar— y el día que el front esté, se prende sin
   * tocar código.
   *
   * Se lee en cada llamada y no una vez al arrancar, para que prenderlo o
   * apagarlo no dependa de cuándo arrancó cada instancia.
   */
  isRequired(): boolean {
    return (
      (this.config.get<string>("REQUIRE_VEHICLE_VERIFICATION") ?? "false")
        .trim()
        .toLowerCase() === "true"
    );
  }

  /**
   * Lanza si el auto no puede publicarse ni recibir reservas nuevas:
   *
   *   · 409 VEHICLE_NOT_VERIFIED — no tiene una verificación aprobada, o la
   *     que tiene dejó de valer (la patente cambió, el auto cambió de dueño);
   *   · 409 VEHICLE_INSURANCE_EXPIRED — la verificación está bien pero el
   *     seguro venció (antes de hoy, por día, en UTC).
   *
   * Son dos códigos porque son dos salidas distintas para el dueño: verificar
   * el auto o renovar la póliza. Con el flag apagado no consulta nada.
   */
  async assertVehicleVerified(vehicleId: string): Promise<void> {
    if (!this.isRequired()) return;

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, ownerId: true, plate: true, verification: true },
    });
    if (!vehicle) throw vehicleNotFound();

    const row = vehicle.verification;
    const standing = evaluateVehicleStanding(row, vehicle);
    if (standing.verified) return;

    throw new ConflictException({
      statusCode: 409,
      code: standing.insuranceOnly
        ? "VEHICLE_INSURANCE_EXPIRED"
        : "VEHICLE_NOT_VERIFIED",
      message: standing.reasons.map((reason) => reason.message).join(" "),
      reasons: standing.reasons,
      vehicleId,
      verificationStatus: row?.status ?? "NOT_SUBMITTED",
      insuranceExpiresAt: isoDay(row?.insuranceExpiresAt ?? null),
    });
  }

  // ── Flujo del dueño ────────────────────────────────────────────────────

  /**
   * Firma la subida de un lado de la cédula. Se niega de entrada cuando el
   * envío también se negaría: firmar igual dejaría subir una foto con el DNI
   * del titular que no se va a poder usar nunca, y que nadie borraría.
   */
  async signUpload(ownerId: string, vehicleId: string, side: CedulaSide) {
    const vehicle = await this.getOwnedVehicle(ownerId, vehicleId);
    const existing = await this.prisma.vehicleVerification.findUnique({
      where: { vehicleId },
    });
    this.assertCanSubmit(existing, vehicle, new Date());
    return this.documents.signUpload(ownerId, vehicleId, side);
  }

  async submit(
    ownerId: string,
    vehicleId: string,
    dto: SubmitVehicleVerificationDto,
    context: RequestContext,
  ): Promise<VehicleVerificationOwnerView> {
    const vehicle = await this.getOwnedVehicle(ownerId, vehicleId);
    const existing = await this.prisma.vehicleVerification.findUnique({
      where: { vehicleId },
    });
    const now = new Date();
    this.assertCanSubmit(existing, vehicle, now);

    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { firstName: true, lastName: true, dni: true },
    });
    assertFound(owner, "User not found");

    // Primero lo declarado y después las fotos: validar las URLs cuesta una
    // llamada a Cloudinary por foto, y no tiene sentido gastarla en un envío
    // que igual se va a rechazar por una patente mal escrita.
    const declared = this.parseSubmission(dto, vehicle, owner, now);
    const urls = await this.documents.validateSubmission(
      ownerId,
      vehicleId,
      dto,
    );

    const data = {
      ownerId,
      status: VehicleVerificationStatus.PENDING,
      cedulaFrontUrl: urls.frontUrl,
      cedulaBackUrl: urls.backUrl,
      plate: declared.plate,
      chassisNumberEncrypted: this.encryption.encrypt(declared.chassisNumber),
      holderRelation: declared.holderRelation,
      holderName: declared.holderName,
      holderDniEncrypted: this.encryption.encrypt(declared.holderDni),
      insurerName: declared.insurerName,
      insurancePolicyNumberEncrypted: this.encryption.encrypt(
        declared.insurancePolicyNumber,
      ),
      insuranceExpiresAt: declared.insuranceExpiresAt,
      insuranceCoversRental: true,
      vtvExpiresAt: declared.vtvExpiresAt,
      // Envío nuevo, revisión nueva: lo que un admin dijo de las fotos
      // anteriores no describe a estas.
      reasonCodes: [],
      notes: null,
      reviewedById: null,
      reviewedAt: null,
      photosPurgedAt: null,
    };

    const row = await this.prisma.vehicleVerification.upsert({
      where: { vehicleId },
      create: { vehicleId, ...data },
      update: data,
    });

    // Las fotos anteriores se borran DESPUÉS de guardar las nuevas. Al revés,
    // si la escritura fallara, la fila vieja quedaría apuntando a fotos que ya
    // no existen y el admin no tendría qué mirar. Así, lo peor que puede pasar
    // es una foto de más en el storage, que queda nombrada en el log.
    if (existing) {
      await this.documents.deleteDocuments(
        [existing.cedulaFrontUrl, existing.cedulaBackUrl].filter(
          (url) => url && url !== urls.frontUrl && url !== urls.backUrl,
        ),
      );
    }

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: ownerId,
      action: "vehicle.verification.submit",
      entityType: "VehicleVerification",
      entityId: row.id,
      metadata: {
        vehicleId,
        previousStatus: existing?.status ?? null,
        renewal: existing?.status === VehicleVerificationStatus.APPROVED,
        ip: context.ip,
        userAgent: context.userAgent,
      },
    });

    return this.toOwnerView(vehicle, row);
  }

  async getForOwner(
    ownerId: string,
    vehicleId: string,
  ): Promise<VehicleVerificationOwnerView> {
    const vehicle = await this.getOwnedVehicle(ownerId, vehicleId);
    const row = await this.prisma.vehicleVerification.findUnique({
      where: { vehicleId },
    });
    return this.toOwnerView(vehicle, row);
  }

  // ── Panel del admin ────────────────────────────────────────────────────

  /**
   * La cola de revisión. Sin datos descifrados ni fotos: listar no es mirar,
   * y así el registro de "quién vio los datos de quién" (que se escribe al
   * abrir UNA verificación) no se diluye en cada vez que alguien abre la cola.
   *
   * Las pendientes salen de la más vieja a la más nueva, que es el orden en el
   * que hay que atenderlas; el resto, por última actividad.
   */
  async adminList(status?: VehicleVerificationStatus) {
    const rows = await this.prisma.vehicleVerification.findMany({
      where: status ? { status } : {},
      include: { vehicle: true },
      orderBy:
        status === VehicleVerificationStatus.PENDING
          ? { createdAt: "asc" }
          : { updatedAt: "desc" },
    });

    const owners = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.ownerId))] } },
      select: OWNER_LIST_SELECT,
    });
    const ownersById = new Map(owners.map((owner) => [owner.id, owner]));
    const now = new Date();

    return rows.map((row) =>
      this.toAdminSummary(
        row,
        row.vehicle,
        ownersById.get(row.ownerId) ?? null,
        now,
      ),
    );
  }

  /**
   * Una verificación entera, para revisarla: los datos descifrados y las fotos
   * con URL firmada.
   *
   * El acceso se registra ANTES de armar la respuesta. Si el registro no se
   * puede escribir, el pedido falla y los datos no se muestran: mirar el DNI
   * del titular y el chasis de un auto sin que quede constancia es justo lo
   * que el registro existe para impedir.
   *
   * Las URLs firmadas no se guardan en ningún lado y la respuesta va con
   * Cache-Control: no-store (lo pone el controller), así el navegador del
   * admin no se queda con una copia.
   */
  async adminGet(actorId: string, id: string, context: RequestContext) {
    const row = await this.prisma.vehicleVerification.findUnique({
      where: { id },
      include: { vehicle: true },
    });
    if (!row) throw verificationNotFound();

    await this.auditLog.create({
      actorId,
      targetUserId: row.ownerId,
      action: "admin.vehicle_verification.view",
      entityType: "VehicleVerification",
      entityId: row.id,
      metadata: {
        vehicleId: row.vehicleId,
        ip: context.ip,
        userAgent: context.userAgent,
      },
    });

    const [owner, samePlate] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: row.ownerId },
        select: { ...USER_SAFE_SELECT, dni: true },
      }),
      // Otras verificaciones con la misma patente, de cualquier auto y en
      // cualquier estado. Es lo que le muestra al admin que puede estar
      // mirando un mellizo ANTES de aprobar, y no recién cuando la aprobación
      // choca con DUPLICATE_PLATE.
      this.prisma.vehicleVerification.findMany({
        where: { plate: row.plate, id: { not: row.id } },
        select: {
          id: true,
          vehicleId: true,
          ownerId: true,
          status: true,
          createdAt: true,
          reviewedAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const decrypted = {
      chassisNumber: this.encryption.tryDecrypt(row.chassisNumberEncrypted),
      holderDni: this.encryption.tryDecrypt(row.holderDniEncrypted),
      insurancePolicyNumber: this.encryption.tryDecrypt(
        row.insurancePolicyNumberEncrypted,
      ),
    };
    // Un dato que está guardado pero no se pudo descifrar no es lo mismo que
    // un dato que no se declaró. Decirlo aparte es lo que permite darse
    // cuenta de una clave mal rotada en vez de pensar que el dueño no cargó el
    // chasis.
    const undecryptable = (
      [
        ["chassisNumber", row.chassisNumberEncrypted],
        ["holderDni", row.holderDniEncrypted],
        ["insurancePolicyNumber", row.insurancePolicyNumberEncrypted],
      ] as const
    )
      .filter(([field, stored]) => stored && decrypted[field] === null)
      .map(([field]) => field);

    return {
      ...this.toAdminSummary(row, row.vehicle, owner, new Date()),
      owner,
      holderName: row.holderName,
      declared: decrypted,
      undecryptable,
      // Lo mismo que se controló al enviar, recalculado contra el perfil de
      // HOY: si la cuenta cambió de nombre después, el admin lo ve acá.
      holderMatchesOwner: owner
        ? {
            name: holderNameMatches(
              row.holderName,
              owner.firstName,
              owner.lastName,
            ),
            dni: sameDni(decrypted.holderDni, owner.dni),
          }
        : null,
      photos: {
        front: this.documents.signedUrl(row.cedulaFrontUrl),
        back: this.documents.signedUrl(row.cedulaBackUrl),
        purgedAt: row.photosPurgedAt,
      },
      samePlate,
      /** El admin es el dueño: el panel no debería ofrecerle revisarla. */
      isOwnVehicle: row.ownerId === actorId || row.vehicle.ownerId === actorId,
      notes: row.notes,
    };
  }

  /**
   * El veredicto de un admin.
   *
   * Un rechazo se puede aplicar siempre, también sobre una aprobada: es la vía
   * para REVOCAR un auto si después aparece un problema (y borra sus fotos).
   * Aprobar, en cambio, solo sobre algo pendiente: una rechazada ya no tiene
   * fotos que mirar.
   */
  async adminReview(
    actorId: string,
    id: string,
    decision: "APPROVED" | "REJECTED",
    notes: string | undefined,
    context: RequestContext,
  ) {
    const row = await this.prisma.vehicleVerification.findUnique({
      where: { id },
      include: { vehicle: true },
    });
    if (!row) throw verificationNotFound();

    // Nadie aprueba su propio auto, ni siquiera un admin: el control existe
    // para que la palabra del dueño la confirme otra persona. Se mira el
    // dueño de la fila Y el del auto, por si no coincidieran.
    if (row.ownerId === actorId || row.vehicle.ownerId === actorId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "SELF_REVIEW_FORBIDDEN",
        message:
          "No podés revisar la verificación de un auto tuyo: tiene que hacerlo otro administrador.",
      });
    }

    if (row.status === VehicleVerificationStatus.REJECTED) {
      throw new BadRequestException({
        statusCode: 400,
        code: "REVIEW_NOT_PENDING",
        message:
          "Esta verificación ya fue rechazada: el dueño tiene que volver a enviar la cédula.",
      });
    }

    const now = new Date();
    let updated: VehicleVerification;

    if (decision === "APPROVED") {
      updated = await this.approve(row, actorId, notes, now);
    } else {
      // Rechazar borra la cédula del storage: un admin ya decidió que no
      // sirve, y guardar el nombre y el DNI del titular sin motivo es lo que
      // no hay que hacer con un dato así. Se borra antes de escribir el
      // estado, como en identidad: si la escritura falla, reintentar el
      // rechazo termina el trabajo.
      await this.documents.deleteDocuments([
        row.cedulaFrontUrl,
        row.cedulaBackUrl,
      ]);
      updated = await this.prisma.vehicleVerification.update({
        where: { id: row.id },
        data: {
          status: VehicleVerificationStatus.REJECTED,
          cedulaFrontUrl: null,
          cedulaBackUrl: null,
          reasonCodes: ["RECHAZADO_POR_ADMIN"],
          notes: notes ?? null,
          reviewedById: actorId,
          reviewedAt: now,
        },
      });
    }

    await this.auditLog.create({
      actorId,
      targetUserId: row.ownerId,
      action: "admin.vehicle_verification.review",
      entityType: "VehicleVerification",
      entityId: row.id,
      metadata: {
        vehicleId: row.vehicleId,
        decision,
        previousStatus: row.status,
        ip: context.ip,
        userAgent: context.userAgent,
      },
    });

    const owner = await this.prisma.user.findUnique({
      where: { id: row.ownerId },
      select: OWNER_LIST_SELECT,
    });
    return {
      ...this.toAdminSummary(updated, row.vehicle, owner, now),
      notes: updated.notes,
    };
  }

  // ── Internos ───────────────────────────────────────────────────────────

  private async approve(
    row: VehicleVerification,
    actorId: string,
    notes: string | undefined,
    now: Date,
  ): Promise<VehicleVerification> {
    if (row.status === VehicleVerificationStatus.APPROVED) {
      throw new BadRequestException({
        statusCode: 400,
        code: "ALREADY_APPROVED",
        message: "Esta verificación ya está aprobada.",
      });
    }
    if (!row.cedulaFrontUrl || !row.cedulaBackUrl) {
      throw new BadRequestException({
        statusCode: 400,
        code: "PHOTOS_MISSING",
        message:
          "Esta verificación no tiene las dos fotos de la cédula: no hay contra qué aprobarla.",
      });
    }
    // Aprobar con el seguro ya vencido dejaría un auto "verificado" que el
    // control de publicar igual frena: una aprobación que no habilita nada y
    // que confunde a todos. Se le pide al dueño la póliza nueva.
    if (!row.insuranceExpiresAt || isExpired(row.insuranceExpiresAt, now)) {
      throw new BadRequestException({
        statusCode: 400,
        code: "INSURANCE_EXPIRED",
        message:
          "El seguro declarado venció mientras la verificación esperaba revisión: el dueño tiene que enviar la póliza renovada.",
        insuranceExpiresAt: isoDay(row.insuranceExpiresAt),
      });
    }

    // El chequeo de patente duplicada y la aprobación van en una misma
    // transacción, con un lock por patente. Sin el lock, dos admins aprobando
    // a la vez los dos autos de un mellizo pasarían los dos el chequeo —cada
    // uno ve que el otro todavía no está aprobado— y quedarían aprobados los
    // dos, que es exactamente lo que el control existe para impedir. El lock
    // es de la transacción: se suelta solo al terminar, pase lo que pase.
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`vehicle-plate:${row.plate}`}))`;

      const clash = await tx.vehicleVerification.findFirst({
        where: {
          plate: row.plate,
          status: VehicleVerificationStatus.APPROVED,
          ownerId: { not: row.ownerId },
        },
        select: { id: true, vehicleId: true },
      });
      if (clash) {
        throw new BadRequestException({
          statusCode: 400,
          code: "DUPLICATE_PLATE",
          message:
            `La patente ${row.plate} ya está verificada para el auto de otra cuenta. ` +
            "Puede ser un auto mellizo o el mismo auto publicado por dos personas: " +
            "revisá las dos verificaciones antes de aprobar.",
          plate: row.plate,
          conflictingVerificationId: clash.id,
          conflictingVehicleId: clash.vehicleId,
        });
      }

      return tx.vehicleVerification.update({
        where: { id: row.id },
        data: {
          status: VehicleVerificationStatus.APPROVED,
          reasonCodes: [],
          notes: notes ?? null,
          reviewedById: actorId,
          reviewedAt: now,
        },
      });
    });
  }

  /** El auto, solo si es de quien pregunta. */
  private async getOwnedVehicle(
    ownerId: string,
    vehicleId: string,
  ): Promise<Vehicle> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) throw vehicleNotFound();
    if (vehicle.ownerId !== ownerId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "NOT_VEHICLE_OWNER",
        message: "Solo el dueño del auto puede verificarlo.",
      });
    }
    return vehicle;
  }

  /** ¿Se acepta hoy un envío para este auto? (ver "Ciclo de vida" arriba) */
  private canSubmit(
    existing: VehicleVerification | null,
    vehicle: Pick<Vehicle, "ownerId" | "plate">,
    now: Date,
  ): boolean {
    if (!existing || existing.status !== VehicleVerificationStatus.APPROVED) {
      return true;
    }
    return !evaluateVehicleStanding(existing, vehicle, now).verified;
  }

  private assertCanSubmit(
    existing: VehicleVerification | null,
    vehicle: Pick<Vehicle, "ownerId" | "plate">,
    now: Date,
  ): void {
    if (this.canSubmit(existing, vehicle, now)) return;
    throw new ConflictException({
      statusCode: 409,
      code: "VEHICLE_ALREADY_VERIFIED",
      message:
        "Este auto ya está verificado. Vas a poder renovar la documentación cuando venza el seguro.",
      insuranceExpiresAt: isoDay(existing?.insuranceExpiresAt ?? null),
    });
  }

  /**
   * Valida y normaliza lo declarado. Junta TODOS los errores antes de fallar
   * —con el nombre exacto del campo— así el front marca cada input que está
   * mal en una sola vuelta, en vez de descubrirlos de a uno por envío.
   */
  private parseSubmission(
    dto: SubmitVehicleVerificationDto,
    vehicle: Vehicle,
    owner: { firstName: string; lastName: string; dni: string | null },
    now: Date,
  ): ParsedSubmission {
    const errors: FieldError[] = [];

    const plate = normalizePlate(dto.plate);
    if (!plateFormat(plate)) {
      errors.push({
        code: "INVALID_PLATE",
        field: "plate",
        message:
          "La patente no tiene un formato válido: tiene que ser como ABC123 o AB123CD.",
      });
    } else if (vehicle.plate && normalizePlate(vehicle.plate) !== plate) {
      // La patente cargada en el auto es la que ve quien reserva y la que
      // queda en el contrato. Si la cédula dice otra, alguna de las dos está
      // mal, y aprobar una cédula de un auto para publicar otro es justo lo
      // que esto tiene que impedir.
      errors.push({
        code: "PLATE_MISMATCH",
        field: "plate",
        message:
          `La patente de la cédula (${plate}) no coincide con la del auto ` +
          `(${normalizePlate(vehicle.plate)}). Corregí la que esté mal.`,
        vehiclePlate: normalizePlate(vehicle.plate),
      });
    }

    const chassisNumber = normalizeVin(dto.chassisNumber);
    const vin = vinProblem(chassisNumber);
    if (vin) {
      errors.push({
        code: "INVALID_CHASSIS",
        field: "chassisNumber",
        problem: vin,
        message:
          vin === "LONGITUD"
            ? `El número de chasis tiene 17 caracteres y el que cargaste tiene ${chassisNumber.length}.`
            : vin === "LETRA_PROHIBIDA"
              ? "El número de chasis no lleva las letras I, O ni Q: si ves una O es un cero, y si ves una I es un uno."
              : "El número de chasis solo tiene letras y números.",
      });
    }

    const holderName = dto.holderName.replace(/\s+/g, " ").trim();
    const holderDni = normalizeDni(dto.holderDni);
    if (!holderName) {
      errors.push({
        code: "FIELD_REQUIRED",
        field: "holderName",
        message: "Falta el nombre del titular, como figura en la cédula.",
      });
    }
    if (!isValidDni(holderDni)) {
      errors.push({
        code: "INVALID_HOLDER_DNI",
        field: "holderDni",
        message: "El DNI del titular tiene que tener 7 u 8 dígitos.",
      });
    } else if (holderName) {
      errors.push(
        ...this.checkHolder(dto.holderRelation, holderName, holderDni, owner),
      );
    }

    const insurerName = dto.insurerName.trim();
    if (!insurerName) {
      errors.push({
        code: "FIELD_REQUIRED",
        field: "insurerName",
        message: "Falta el nombre de la aseguradora.",
      });
    }
    const insurancePolicyNumber = dto.insurancePolicyNumber.trim();
    if (!insurancePolicyNumber) {
      errors.push({
        code: "FIELD_REQUIRED",
        field: "insurancePolicyNumber",
        message: "Falta el número de póliza.",
      });
    }

    if (dto.insuranceCoversRental !== true) {
      errors.push({
        code: "INSURANCE_MUST_COVER_RENTAL",
        field: "insuranceCoversRental",
        message:
          "Para publicar el auto, la póliza tiene que cubrir el uso para alquiler. " +
          "Con una póliza de uso particular, la aseguradora puede rechazar un siniestro ocurrido durante una reserva.",
      });
    }

    const insuranceExpiresAt = parseDay(dto.insuranceExpiresAt);
    if (!insuranceExpiresAt) {
      errors.push({
        code: "INVALID_DATE",
        field: "insuranceExpiresAt",
        message: "La fecha de vencimiento del seguro no es una fecha real.",
      });
    } else if (startOfDayUtc(insuranceExpiresAt) <= startOfDayUtc(now)) {
      // Vencer HOY tampoco alcanza: el control de publicar lo daría por
      // vencido mañana, y una verificación no se revisa en el día. Aceptarlo
      // sería mandar a la cola algo que va a estar vencido cuando alguien lo
      // mire.
      errors.push({
        code: "INSURANCE_EXPIRED",
        field: "insuranceExpiresAt",
        message:
          "El seguro tiene que estar vigente: la fecha de vencimiento tiene que ser posterior a hoy.",
      });
    }

    let vtvExpiresAt: Date | null = null;
    if (dto.vtvExpiresAt) {
      vtvExpiresAt = parseDay(dto.vtvExpiresAt);
      if (!vtvExpiresAt) {
        errors.push({
          code: "INVALID_DATE",
          field: "vtvExpiresAt",
          message: "La fecha de vencimiento de la VTV no es una fecha real.",
        });
      }
    }

    if (errors.length > 0) {
      const [first] = errors;
      throw new BadRequestException({
        statusCode: 400,
        ...first,
        errors,
      });
    }

    return {
      plate,
      chassisNumber,
      holderRelation: dto.holderRelation,
      holderName,
      holderDni,
      insurerName,
      insurancePolicyNumber,
      insuranceExpiresAt: insuranceExpiresAt as Date,
      vtvExpiresAt,
    };
  }

  /**
   * ¿El titular declarado es coherente con quién está enviando?
   *
   * TITULAR: el nombre y el DNI de la cédula tienen que ser los de la cuenta,
   * que ya están verificados contra su DNI. Es lo que convierte "digo que el
   * auto es mío" en algo que se puede sostener.
   *
   * AUTORIZADO: el titular es OTRA persona. Solo se compara el DNI y no el
   * nombre, a propósito: que un padre y un hijo se llamen igual es de lo más
   * común, y el hijo autorizado a manejar el auto del padre es justamente el
   * caso que esta opción existe para cubrir. Un DNI igual, en cambio, es la
   * misma persona eligiendo la opción equivocada.
   */
  private checkHolder(
    relation: VehicleHolderRelation,
    holderName: string,
    holderDni: string,
    owner: { firstName: string; lastName: string; dni: string | null },
  ): FieldError[] {
    if (relation === VehicleHolderRelation.AUTORIZADO) {
      return sameDni(holderDni, owner.dni)
        ? [
            {
              code: "HOLDER_IS_OWNER",
              field: "holderRelation",
              message:
                "El DNI del titular es el tuyo: si el auto está a tu nombre, elegí «titular».",
            },
          ]
        : [];
    }

    const mismatched: ("holderName" | "holderDni")[] = [];
    if (!holderNameMatches(holderName, owner.firstName, owner.lastName)) {
      mismatched.push("holderName");
    }
    if (!sameDni(holderDni, owner.dni)) mismatched.push("holderDni");
    if (mismatched.length === 0) return [];

    return [
      {
        code: "HOLDER_MISMATCH",
        field: mismatched[0],
        mismatched,
        message:
          "Si sos el titular, el nombre y el DNI de la cédula tienen que ser los de tu cuenta. " +
          "Si el auto está a nombre de otra persona, elegí «autorizado».",
      },
    ];
  }

  private toOwnerView(
    vehicle: Vehicle,
    row: VehicleVerification | null,
  ): VehicleVerificationOwnerView {
    const now = new Date();
    const standing = evaluateVehicleStanding(row, vehicle, now);
    const reveal = (stored: string | null) =>
      maskTail(this.encryption.tryDecrypt(stored));

    return {
      vehicleId: vehicle.id,
      id: row?.id ?? null,
      status: row?.status ?? "NOT_SUBMITTED",
      required: this.isRequired(),
      verified: standing.verified,
      reasonCodes: row?.reasonCodes ?? [],
      reasons: standing.reasons,
      declared: row
        ? {
            plate: row.plate,
            chassisNumber: reveal(row.chassisNumberEncrypted),
            holderRelation: row.holderRelation,
            holderName: row.holderName,
            holderDni: reveal(row.holderDniEncrypted),
            insurerName: row.insurerName,
            insurancePolicyNumber: reveal(row.insurancePolicyNumberEncrypted),
            insuranceCoversRental: row.insuranceCoversRental,
          }
        : null,
      photos: {
        front: Boolean(row?.cedulaFrontUrl),
        back: Boolean(row?.cedulaBackUrl),
      },
      insuranceExpiresAt: isoDay(row?.insuranceExpiresAt ?? null),
      vtvExpiresAt: isoDay(row?.vtvExpiresAt ?? null),
      insuranceValid: standing.insuranceValid,
      insuranceExpiresSoon: standing.insuranceExpiresSoon,
      vtvValid: standing.vtvValid,
      plateMatchesVehicle: standing.plateMatchesVehicle,
      canSubmit: this.canSubmit(row, vehicle, now),
      reviewedAt: row?.reviewedAt ?? null,
      createdAt: row?.createdAt ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** Una fila para el panel, sin datos descifrados ni URLs. */
  private toAdminSummary(
    row: VehicleVerification,
    vehicle: Vehicle,
    owner: OwnerSummary | null,
    now: Date,
  ) {
    const standing = evaluateVehicleStanding(row, vehicle, now);
    return {
      id: row.id,
      vehicleId: row.vehicleId,
      ownerId: row.ownerId,
      owner: owner
        ? {
            id: owner.id,
            email: owner.email,
            firstName: owner.firstName,
            lastName: owner.lastName,
          }
        : null,
      vehicle: {
        id: vehicle.id,
        brand: vehicle.brand,
        model: vehicle.model,
        year: vehicle.year,
        plate: vehicle.plate,
      },
      status: row.status,
      plate: row.plate,
      holderRelation: row.holderRelation,
      insurerName: row.insurerName,
      insuranceExpiresAt: isoDay(row.insuranceExpiresAt),
      insuranceCoversRental: row.insuranceCoversRental,
      vtvExpiresAt: isoDay(row.vtvExpiresAt),
      insuranceValid: standing.insuranceValid,
      vtvValid: standing.vtvValid,
      plateMatchesVehicle: standing.plateMatchesVehicle,
      reasonCodes: row.reasonCodes,
      hasPhotos: {
        front: Boolean(row.cedulaFrontUrl),
        back: Boolean(row.cedulaBackUrl),
      },
      photosPurgedAt: row.photosPurgedAt,
      reviewedById: row.reviewedById,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function vehicleNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    code: "VEHICLE_NOT_FOUND",
    message: "No encontramos ese auto.",
  });
}

function verificationNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    code: "VEHICLE_VERIFICATION_NOT_FOUND",
    message: "No existe esa verificación.",
  });
}
