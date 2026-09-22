import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BookingStatus,
  DamageClaim,
  DamageClaimStatus,
  PaymentRecordKind,
  PaymentRecordStatus,
} from "@prisma/client";
import { AuditLogService } from "../common/services/audit-log.service";
import { assertFound } from "../common/utils/entity.util";
import { PrismaService } from "../prisma/prisma.service";
import { PaymentsService } from "../payments/payments.service";
import {
  OpenDamageClaimDto,
  ResolveDamageClaimDto,
  RespondDamageClaimDto,
} from "./dto/damage-claim.dto";

/**
 * RECLAMOS POR DAÑOS: LA VENTANA DE 48 HORAS DESPUÉS DE LA DEVOLUCIÓN.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * Antes, confirmar la devolución cerraba todo en el acto: se soltaba el
 * depósito y se le pagaba al dueño. El dueño que encontraba un golpe al revisar
 * el auto una hora más tarde ya no tenía de dónde cobrarlo, y su única salida
 * era un juicio contra una persona que apenas conoce.
 *
 * ── Los plazos, y por qué son cortos ────────────────────────────────────────
 * El dueño tiene 48 horas desde la devolución para reportar el daño con fotos
 * y un monto. Es corto a propósito: un daño se ve al recibir el auto, y cuanto
 * más tiempo pasa menos se puede distinguir lo que pasó durante el alquiler de
 * lo que pasó después. Airbnb da 14 días para un inmueble; Turo, que alquila
 * autos, pide reportar dentro de las 24 horas. 48 es el punto entre "el dueño
 * no llegó a revisarlo" y "ya no se sabe quién lo hizo".
 *
 * Quien alquiló tiene otras 48 horas para aceptar o rechazar. El silencio NO
 * es aceptación: si no contesta, el reclamo pasa a que lo resuelva un
 * administrador con la evidencia de las dos partes. Cobrarle a alguien por no
 * contestar un mail sería exactamente la clase de cláusula que un juez tira
 * abajo.
 *
 * ── Qué NO hace este plazo ──────────────────────────────────────────────────
 * No extingue el derecho de nadie. Rige el PROCEDIMIENTO DE LA PLATAFORMA y el
 * uso del depósito: pasadas las 48 horas se libera la garantía y se liquida.
 * Lo que las partes puedan reclamarse por vía judicial no lo puede acortar un
 * contrato (art. 2533 del Código Civil y Comercial).
 */
@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
  ) {}

  private responseHours(): number {
    const horas = Number.parseFloat(
      this.config.get<string>("DAMAGE_CLAIM_RESPONSE_HOURS") ?? "",
    );
    return Number.isFinite(horas) && horas > 0 ? horas : 48;
  }

  /** El dueño abre el reclamo, dentro de la ventana y con fotos. */
  async open(ownerId: string, bookingId: string, dto: OpenDamageClaimDto) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    assertFound(booking, "Booking not found");
    if (booking.ownerId !== ownerId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "NOT_THE_OWNER",
        message: "Solo el dueño del auto puede reclamar un daño.",
      });
    }
    if (booking.status !== BookingStatus.INSPECTION) {
      throw new ConflictException({
        statusCode: 409,
        code: "INSPECTION_NOT_OPEN",
        message:
          booking.status === BookingStatus.DISPUTED
            ? "Ya hay un reclamo abierto en esta reserva."
            : "Solo se puede reclamar un daño sobre un auto recién devuelto.",
        bookingStatus: booking.status,
      });
    }
    const ahora = new Date();
    if (booking.inspectionEndsAt && booking.inspectionEndsAt < ahora) {
      throw new ConflictException({
        statusCode: 409,
        code: "INSPECTION_WINDOW_CLOSED",
        message:
          "La ventana para reportar daños se cerró. El depósito ya se liberó.",
        inspectionEndsAt: booking.inspectionEndsAt,
      });
    }

    // No se puede reclamar más de lo que hay retenido: el depósito es el único
    // lugar de donde la plataforma puede cobrar. Pedir más sería prometerle al
    // dueño algo que no se puede cumplir.
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
      select: { amountMinor: true },
    });
    const retenido = hold?.amountMinor ?? 0;
    if (retenido <= 0) {
      throw new ConflictException({
        statusCode: 409,
        code: "DEPOSIT_HOLD_NOT_AVAILABLE",
        message:
          "Esta reserva no tiene depósito retenido, así que la plataforma no " +
          "puede cobrar un daño. Podés reclamarle directamente a quien alquiló.",
      });
    }
    if (dto.amountRequestedMinor > retenido) {
      throw new BadRequestException({
        statusCode: 400,
        code: "AMOUNT_EXCEEDS_HOLD",
        message: `No se puede reclamar más de lo retenido (${retenido / 100} ${booking.currency.toUpperCase()}).`,
        maxAmountMinor: retenido,
      });
    }

    const claim = await this.prisma.damageClaim.create({
      data: {
        bookingId,
        ownerId,
        renterId: booking.renterId,
        description: dto.description,
        amountRequestedMinor: dto.amountRequestedMinor,
        currency: booking.currency,
        evidenceUrls: dto.evidenceUrls,
        renterResponseDeadline: new Date(
          ahora.getTime() + this.responseHours() * 60 * 60 * 1000,
        ),
      },
    });
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.DISPUTED },
    });

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: "damage_claim.opened",
      entityType: "Booking",
      entityId: bookingId,
      metadata: {
        claimId: claim.id,
        amountMinor: dto.amountRequestedMinor,
        evidence: dto.evidenceUrls.length,
      },
    });
    this.logger.log(
      `Reclamo ${claim.id} abierto en ${bookingId} por ${dto.amountRequestedMinor}`,
    );
    return this.view(claim);
  }

  /** Quien alquiló acepta o rechaza. Aceptar cobra del depósito. */
  async respond(renterId: string, claimId: string, dto: RespondDamageClaimDto) {
    const claim = await this.prisma.damageClaim.findUnique({
      where: { id: claimId },
    });
    assertFound(claim, "Claim not found");
    if (claim.renterId !== renterId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "NOT_THE_RENTER",
        message: "Solo quien alquiló puede responder este reclamo.",
      });
    }
    if (claim.status !== DamageClaimStatus.OPEN) {
      throw new ConflictException({
        statusCode: 409,
        code: "CLAIM_NOT_OPEN",
        message: "Este reclamo ya no espera tu respuesta.",
        claimStatus: claim.status,
      });
    }

    const updated = await this.prisma.damageClaim.update({
      where: { id: claimId },
      data: {
        status: dto.accept
          ? DamageClaimStatus.ACCEPTED
          : DamageClaimStatus.CONTESTED,
        amountApprovedMinor: dto.accept ? claim.amountRequestedMinor : null,
        renterResponse: dto.response ?? null,
        renterRespondedAt: new Date(),
      },
    });

    await this.auditLog.create({
      actorId: renterId,
      targetUserId: claim.ownerId,
      action: dto.accept ? "damage_claim.accepted" : "damage_claim.contested",
      entityType: "Booking",
      entityId: claim.bookingId,
      metadata: { claimId },
    });

    // Aceptado: no hace falta que intervenga nadie. Se cobra y se cierra.
    if (dto.accept) await this.settleAfterResolution(claim.bookingId, renterId);
    return this.view(updated);
  }

  /** El dueño se arrepiente del reclamo: se libera el depósito y se liquida. */
  async withdraw(ownerId: string, claimId: string) {
    const claim = await this.prisma.damageClaim.findUnique({
      where: { id: claimId },
    });
    assertFound(claim, "Claim not found");
    if (claim.ownerId !== ownerId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "NOT_THE_OWNER",
        message: "Solo quien abrió el reclamo puede retirarlo.",
      });
    }
    if (
      claim.status !== DamageClaimStatus.OPEN &&
      claim.status !== DamageClaimStatus.CONTESTED
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: "CLAIM_NOT_OPEN",
        message: "Este reclamo ya está resuelto.",
      });
    }

    const updated = await this.prisma.damageClaim.update({
      where: { id: claimId },
      data: { status: DamageClaimStatus.WITHDRAWN, amountApprovedMinor: 0 },
    });
    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: claim.renterId,
      action: "damage_claim.withdrawn",
      entityType: "Booking",
      entityId: claim.bookingId,
      metadata: { claimId },
    });
    await this.settleAfterResolution(claim.bookingId, ownerId);
    return this.view(updated);
  }

  /**
   * Un administrador resuelve un reclamo rechazado o sin responder. Puede
   * aprobar menos de lo reclamado —o nada—, y tiene que explicar por qué: esa
   * explicación la leen las dos partes.
   */
  async resolve(adminId: string, claimId: string, dto: ResolveDamageClaimDto) {
    const claim = await this.prisma.damageClaim.findUnique({
      where: { id: claimId },
    });
    assertFound(claim, "Claim not found");
    if (adminId === claim.ownerId || adminId === claim.renterId) {
      // Un administrador que es parte del alquiler no puede decidir sobre su
      // propia plata, por más administrador que sea.
      throw new ForbiddenException({
        statusCode: 403,
        code: "SELF_REVIEW_FORBIDDEN",
        message:
          "No podés resolver un reclamo de una reserva en la que sos parte.",
      });
    }
    if (
      claim.status !== DamageClaimStatus.OPEN &&
      claim.status !== DamageClaimStatus.CONTESTED
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: "CLAIM_ALREADY_RESOLVED",
        message: "Este reclamo ya está resuelto.",
        claimStatus: claim.status,
      });
    }
    if (dto.approvedAmountMinor > claim.amountRequestedMinor) {
      throw new BadRequestException({
        statusCode: 400,
        code: "AMOUNT_EXCEEDS_CLAIM",
        message: "No se puede aprobar más de lo que el dueño reclamó.",
      });
    }

    const updated = await this.prisma.damageClaim.update({
      where: { id: claimId },
      data: {
        status: DamageClaimStatus.RESOLVED,
        amountApprovedMinor: dto.approvedAmountMinor,
        resolutionNote: dto.note,
        resolvedById: adminId,
        resolvedAt: new Date(),
      },
    });
    await this.auditLog.create({
      actorId: adminId,
      targetUserId: claim.renterId,
      action: "damage_claim.resolved",
      entityType: "Booking",
      entityId: claim.bookingId,
      metadata: { claimId, approvedMinor: dto.approvedAmountMinor },
    });
    await this.settleAfterResolution(claim.bookingId, adminId);
    return this.view(updated);
  }

  /**
   * Los reclamos que quien alquiló dejó sin contestar pasan a que los mire un
   * administrador. Lo corre el cron.
   */
  async expireUnanswered(now: Date = new Date()): Promise<number> {
    const vencidos = await this.prisma.damageClaim.findMany({
      where: {
        status: DamageClaimStatus.OPEN,
        renterResponseDeadline: { lt: now },
      },
      select: { id: true, bookingId: true },
      take: 200,
    });
    for (const claim of vencidos) {
      await this.prisma.damageClaim.update({
        where: { id: claim.id },
        data: { status: DamageClaimStatus.CONTESTED },
      });
      await this.auditLog.create({
        action: "damage_claim.unanswered",
        entityType: "Booking",
        entityId: claim.bookingId,
        metadata: { claimId: claim.id },
      });
    }
    return vencidos.length;
  }

  /** El reclamo de una reserva, para cualquiera de las dos partes. */
  async getForBooking(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { ownerId: true, renterId: true },
    });
    assertFound(booking, "Booking not found");
    if (booking.ownerId !== userId && booking.renterId !== userId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "NOT_A_PARTY",
        message: "No sos parte de esta reserva.",
      });
    }
    const claim = await this.prisma.damageClaim.findUnique({
      where: { bookingId },
    });
    return claim ? this.view(claim) : null;
  }

  /** La cola de reclamos para el panel. */
  adminList(status?: DamageClaimStatus) {
    return this.prisma.damageClaim.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  /**
   * Liquida la reserva después de resolver el reclamo. No hace fallar la
   * resolución si la liquidación no puede completarse: el reclamo YA está
   * decidido, y dejarlo sin guardar porque el procesador no contestó sería
   * perder la decisión. El cron lo reintenta.
   */
  private async settleAfterResolution(bookingId: string, actorId: string) {
    try {
      await this.payments.settleBooking(bookingId, actorId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `no se pudo liquidar ${bookingId} después de resolver el reclamo: ${message}`,
      );
    }
  }

  private view(claim: DamageClaim) {
    return {
      id: claim.id,
      bookingId: claim.bookingId,
      status: claim.status,
      description: claim.description,
      amountRequestedMinor: claim.amountRequestedMinor,
      amountApprovedMinor: claim.amountApprovedMinor,
      currency: claim.currency,
      evidenceUrls: claim.evidenceUrls,
      renterResponse: claim.renterResponse,
      renterRespondedAt: claim.renterRespondedAt,
      renterResponseDeadline: claim.renterResponseDeadline,
      resolutionNote: claim.resolutionNote,
      resolvedAt: claim.resolvedAt,
      createdAt: claim.createdAt,
      updatedAt: claim.updatedAt,
    };
  }
}
