import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { BookingStatus, DamageClaimStatus } from "@prisma/client";
import { AuditLogService } from "../common/services/audit-log.service";
import { assertFound } from "../common/utils/entity.util";
import { assertParticipant } from "../common/utils/authorization.util";
import { PaymentsService } from "../payments/payments.service";
import { PrismaService } from "../prisma/prisma.service";
import { USER_PUBLIC_SELECT } from "../common/constants/prisma-select";
import { estadoDeLaRevision, HORAS_DE_REVISION } from "./claim-window";
import { CreateDamageClaimDto } from "./dto/create-damage-claim.dto";
import { ResolveDamageClaimDto } from "./dto/resolve-damage-claim.dto";

/**
 * claims.service.ts — El reclamo de un daño sobre el depósito en garantía
 * ---------------------------------------------------------------------------
 * ── QUIÉN HACE QUÉ, Y POR QUÉ ASÍ ─────────────────────────────────────────
 * El dueño RECLAMA. Un administrador RESUELVE. El dueño no cobra nunca solo.
 *
 * No es burocracia: es plata de otra persona y las dos partes tienen intereses
 * opuestos exactamente acá. Si el dueño pudiera capturar el depósito por su
 * cuenta, el depósito sería un botón para quedarse con doscientos dólares
 * ajenos sin que nadie mire, y ningún inquilino volvería a dejar uno.
 *
 * ── LA VENTANA ────────────────────────────────────────────────────────────
 * El reclamo se abre dentro de las 48 horas de confirmada la devolución, y
 * mientras tanto el depósito sigue retenido. Está explicado en claim-window.ts:
 * sin esa ventana el reclamo llegaría siempre tarde, porque la retención ya
 * estaría soltada y no habría nada que capturar.
 *
 * ── LO QUE ESTE SERVICIO NO DECIDE ────────────────────────────────────────
 * Cuánto se cobra. Eso lo decide quien resuelve, mirando las fotos, y puede ser
 * menos de lo reclamado. El tope lo pone el depósito retenido y lo controla
 * PaymentsService.captureDeposit, que además es quien manda los mails a las dos
 * partes.
 */
@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Lo que la pantalla del dueño necesita saber para ofrecer el reclamo. */
  async estadoDeLaReserva(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        ownerId: true,
        renterId: true,
        status: true,
        currency: true,
        returnConfirmedAt: true,
        depositSnapshot: true,
        depositCapturedAmount: true,
      },
    });
    assertFound(booking, "Booking not found");
    assertParticipant(
      booking.ownerId,
      booking.renterId,
      userId,
      "You cannot access this booking",
    );

    const claims = await this.prisma.damageClaim.findMany({
      where: { bookingId },
      orderBy: { createdAt: "desc" },
      include: { owner: { select: USER_PUBLIC_SELECT } },
    });
    const abierto = claims.find((c) => c.status === DamageClaimStatus.OPEN);

    const revision = estadoDeLaRevision({
      status: booking.status,
      returnConfirmedAt: booking.returnConfirmedAt,
      hayReclamoAbierto: Boolean(abierto),
      ahora: new Date(),
    });

    return {
      bookingId,
      // Solo el dueño reclama; al inquilino esto le sirve para VER el reclamo
      // que le hicieron, que es lo que explica por qué su garantía sigue
      // retenida.
      puedeReclamar: revision.abierta && booking.ownerId === userId,
      horasDeRevision: HORAS_DE_REVISION,
      venceLaRevision: revision.vence,
      horasQueQuedan: revision.horasQueQuedan,
      depositoRetenido: booking.depositSnapshot,
      // Si ya se cobró algo de la garantía: la pantalla lo dice en vez de
      // ofrecer reclamar de nuevo sobre algo que ya se resolvió.
      depositoCobrado: booking.depositCapturedAmount,
      moneda: booking.currency,
      claims,
    };
  }

  /** El dueño abre el reclamo. */
  async crear(ownerId: string, bookingId: string, dto: CreateDamageClaimDto) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        ownerId: true,
        renterId: true,
        status: true,
        currency: true,
        returnConfirmedAt: true,
        depositSnapshot: true,
      },
    });
    assertFound(booking, "Booking not found");
    if (booking.ownerId !== ownerId) {
      throw new ForbiddenException(
        "Solo el dueño del auto puede reclamar un daño",
      );
    }

    const abierto = await this.prisma.damageClaim.findFirst({
      where: { bookingId, status: DamageClaimStatus.OPEN },
      select: { id: true },
    });
    if (abierto) {
      throw new BadRequestException({
        statusCode: 400,
        code: "CLAIM_ALREADY_OPEN",
        message:
          "Ya hay un reclamo abierto por esta reserva. Se resuelve ese; no se " +
          "abre otro encima.",
      });
    }

    const revision = estadoDeLaRevision({
      status: booking.status,
      returnConfirmedAt: booking.returnConfirmedAt,
      ahora: new Date(),
    });
    if (!revision.abierta) {
      /*
        DOS MOTIVOS DISTINTOS, PORQUE SE ARREGLAN DE FORMA DISTINTA.

        Todavía no devuelto: el reclamo no llegó tarde, llegó temprano, y hay
        que esperar a que el auto vuelva. Vencido: el plazo pasó y el depósito
        ya se soltó o está por soltarse, así que lo que queda es el chat y un
        administrador, no este botón.
      */
      const noVolvio = booking.status !== BookingStatus.COMPLETED;
      throw new BadRequestException({
        statusCode: 400,
        code: noVolvio ? "BOOKING_NOT_RETURNED" : "CLAIM_WINDOW_CLOSED",
        message: noVolvio
          ? "El auto todavía no fue devuelto: el reclamo se abre cuando vuelve."
          : `El plazo para reclamar era de ${HORAS_DE_REVISION} horas desde la ` +
            "devolución y ya pasó. El depósito se liberó.",
      });
    }

    // No se puede reclamar más de lo que hay retenido: sería pedir plata que
    // este circuito no puede mover, y termina en una expectativa que nadie
    // puede cumplir.
    const topeMinor = Math.round((booking.depositSnapshot ?? 0) * 100);
    if (topeMinor > 0 && dto.claimedAmountMinor > topeMinor) {
      throw new BadRequestException({
        statusCode: 400,
        code: "CLAIM_OVER_DEPOSIT",
        message:
          "No se puede reclamar más de lo que quedó retenido como garantía. " +
          "Si el daño es mayor, el reclamo va aparte del depósito.",
      });
    }

    const claim = await this.prisma.damageClaim.create({
      data: {
        bookingId,
        ownerId,
        description: dto.description.trim(),
        claimedAmountMinor: dto.claimedAmountMinor,
        evidenceUrls: dto.evidenceUrls,
      },
    });

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: "booking.damage_claim.opened",
      entityType: "Booking",
      entityId: bookingId,
      metadata: {
        claimId: claim.id,
        claimedAmountMinor: dto.claimedAmountMinor,
        fotos: dto.evidenceUrls.length,
      },
    });
    this.logger.log(
      `Reclamo ${claim.id} abierto por el dueño ${ownerId} sobre la reserva ${bookingId}`,
    );

    return claim;
  }

  /**
   * "ESTÁ TODO BIEN": el dueño cierra la ventana antes de tiempo.
   *
   * Es el camino normal y el que el mail le pide. Sin esto, la garantía de
   * alguien que devolvió el auto impecable queda retenida dos días por las
   * dudas, y el dueño no tiene forma de destrabarla aunque quiera.
   */
  async todoBien(ownerId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, ownerId: true, renterId: true, status: true },
    });
    assertFound(booking, "Booking not found");
    if (booking.ownerId !== ownerId) {
      throw new ForbiddenException("Solo el dueño del auto puede hacer esto");
    }
    if (booking.status !== BookingStatus.COMPLETED) {
      throw new BadRequestException({
        statusCode: 400,
        code: "BOOKING_NOT_RETURNED",
        message: "El auto todavía no fue devuelto.",
      });
    }

    const resultado = await this.payments.liberarDepositoSiCorresponde(
      ownerId,
      bookingId,
      { forzar: true },
    );

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: "booking.inspection_ok",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { liberado: resultado.liberado, motivo: resultado.motivo },
    });

    return resultado;
  }

  /** Los reclamos abiertos, para el panel. */
  listarAbiertos() {
    return this.prisma.damageClaim.findMany({
      where: { status: DamageClaimStatus.OPEN },
      orderBy: { createdAt: "asc" },
      include: {
        owner: { select: USER_PUBLIC_SELECT },
        booking: {
          select: {
            id: true,
            currency: true,
            depositSnapshot: true,
            returnConfirmedAt: true,
            renter: { select: USER_PUBLIC_SELECT },
            vehicle: { select: { brand: true, model: true, year: true } },
          },
        },
      },
    });
  }

  /**
   * UN ADMINISTRADOR RESUELVE.
   *
   * Aceptar cobra del depósito —el importe lo decide quien resuelve, no el
   * reclamo— y rechazar libera la garantía entera. Las dos cosas le avisan a
   * las dos partes: el mail de la captura lo manda PaymentsService, y el del
   * rechazo es el de la liberación de siempre.
   */
  async resolver(adminId: string, claimId: string, dto: ResolveDamageClaimDto) {
    const claim = await this.prisma.damageClaim.findUnique({
      where: { id: claimId },
    });
    assertFound(claim, "Damage claim not found");
    if (claim.status !== DamageClaimStatus.OPEN) {
      throw new BadRequestException({
        statusCode: 400,
        code: "CLAIM_ALREADY_RESOLVED",
        message: "Este reclamo ya estaba resuelto.",
      });
    }

    if (!dto.aceptar) {
      /*
        RECHAZAR ES CERRAR PRIMERO Y SOLTAR DESPUÉS, EN ESE ORDEN.

        Al revés no sale: mientras el reclamo figure abierto, soltar el depósito
        está prohibido a propósito (ver liberarDepositoSiCorresponde), porque
        eso sería resolver el reclamo por goteo y sin que quede escrito.
      */
      const cerrado = await this.prisma.damageClaim.update({
        where: { id: claimId },
        data: {
          status: DamageClaimStatus.REJECTED,
          resolvedById: adminId,
          resolvedAt: new Date(),
          resolutionNote: dto.nota.trim(),
          capturedAmountMinor: 0,
        },
      });
      await this.payments.liberarDepositoSiCorresponde(
        adminId,
        claim.bookingId,
        { forzar: true },
      );
      await this.auditLog.create({
        actorId: adminId,
        targetUserId: claim.ownerId,
        action: "booking.damage_claim.rejected",
        entityType: "Booking",
        entityId: claim.bookingId,
        metadata: { claimId, nota: dto.nota },
      });
      return cerrado;
    }

    const amountMinor = dto.amountMinor ?? claim.claimedAmountMinor;
    if (!amountMinor || amountMinor <= 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: "CLAIM_AMOUNT_REQUIRED",
        message: "Para aceptar un reclamo hay que decir cuánto se cobra.",
      });
    }

    // El motivo que va a leer quien alquiló lleva las dos cosas: lo que
    // reclamó el dueño y lo que resolvió la plataforma. Con una sola de las
    // dos, el mail explica la mitad.
    const motivo = `${claim.description.trim()} — Resolución: ${dto.nota.trim()}`;
    await this.payments.captureDeposit(
      adminId,
      claim.bookingId,
      amountMinor,
      motivo,
    );

    const resuelto = await this.prisma.damageClaim.update({
      where: { id: claimId },
      data: {
        status: DamageClaimStatus.ACCEPTED,
        resolvedById: adminId,
        resolvedAt: new Date(),
        resolutionNote: dto.nota.trim(),
        capturedAmountMinor: amountMinor,
      },
    });

    await this.auditLog.create({
      actorId: adminId,
      targetUserId: claim.ownerId,
      action: "booking.damage_claim.accepted",
      entityType: "Booking",
      entityId: claim.bookingId,
      metadata: { claimId, amountMinor, nota: dto.nota },
    });

    return resuelto;
  }
}
