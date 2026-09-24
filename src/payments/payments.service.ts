import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Booking,
  BookingStatus,
  DamageClaimStatus,
  PaymentRecord,
  PaymentRecordKind,
  PaymentRecordStatus,
  PaymentStatus,
  Prisma,
  User,
} from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { AuditLogService } from "../common/services/audit-log.service";
import { EncryptionService } from "../common/crypto/encryption.service";
import { USER_CONTACT_SELECT } from "../common/constants/prisma-select";
import { EmailService } from "../email/email.service";
import { assertFound } from "../common/utils/entity.util";
import { assertParticipant } from "../common/utils/authorization.util";
import { PrismaService } from "../prisma/prisma.service";
import { ContractsService } from "../contracts/contracts.service";
import { LedgerService } from "../ledger/ledger.service";
import { Accounts } from "../ledger/accounts";
import { decidirCancelacion } from "../bookings/cancellation-policy";
import { getFrontendUrl, getPublicApiBaseUrl } from "../config/public-urls";
import { buildTicket, Ticket } from "./money/ticket";
import {
  CancellationOutcome,
  CancelledBy,
  computeCancellation,
} from "./money/cancellation-policy";
import { reconcileSplitRefund } from "./money/split-refund";
import { PAYMENT_PROVIDER } from "./providers/payment-provider.interface";
import type {
  CardPaymentInput,
  CollectorCredentials,
  PaymentProvider,
  PaymentRecordKindLike,
  PaymentResult,
  ProcessorPaymentStatus,
} from "./providers/payment-provider.interface";
import { mensajeDelMotivo } from "./providers/mercadopago/mercadopago.shared";

/** Estados en los que la plata efectivamente entró. */
const PAID_RECORD_STATUSES: PaymentRecordStatus[] = [
  PaymentRecordStatus.PAID,
  PaymentRecordStatus.CAPTURED,
];

/** Un cobro todavía sin resolver: ni aprobado ni rechazado. */
const OPEN_RECORD_STATUSES: PaymentRecordStatus[] = [
  PaymentRecordStatus.REQUIRES_ACTION,
  PaymentRecordStatus.PROCESSING,
];

/** Lo que se le pide al banco que muestre en el resumen de la tarjeta. */
const DESCRIPTOR_POR_DEFECTO = "FREEWHEEL";

/** Cuánto antes del retiro se puede autorizar el depósito, por omisión. */
const HORAS_DE_AUTORIZACION_POR_DEFECTO = 48;

/** Cuánto vale el `state` del OAuth: lo que tarda alguien en vincular. */
const VIGENCIA_DEL_STATE_MS = 20 * 60 * 1000;

/**
 * Con cuánta anticipación se renueva el token de un dueño. Los tokens de
 * Mercado Pago duran 180 días; renovarlos con margen evita que venzan en el
 * medio de un reembolso.
 */
const RENOVAR_ANTES_DE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * QUIÉN PIDIÓ ESTO Y DESDE DÓNDE.
 *
 * Viaja con cada pedido que mueve plata y queda guardado en el registro. No es
 * telemetría: es lo que permite contestar un desconocimiento de cobro ("este
 * pago salió de esta IP, con esta tarjeta, a esta hora") y ver el patrón de
 * alguien que prueba tarjetas robadas desde una misma conexión.
 */
export interface PaymentContext {
  actorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** El orden en que avanza un cobro. Nunca se vuelve para atrás. */
const RANGO: Record<PaymentRecordStatus, number> = {
  MOCK: 0,
  PENDING: 0,
  REQUIRES_ACTION: 0,
  PROCESSING: 1,
  AUTHORIZED: 2,
  FAILED: 3,
  CANCELLED: 3,
  RELEASED: 3,
  PAID: 3,
  CAPTURED: 3,
  PARTIALLY_REFUNDED: 4,
  REFUNDED: 5,
  DISPUTED: 6,
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly ledger: LedgerService,
    private readonly contracts: ContractsService,
    private readonly encryption: EncryptionService,
  ) {}

  // ── El cobro de la reserva (lo pide quien alquila) ─────────────────────

  /**
   * LO QUE EL FRONT NECESITA PARA MOSTRAR EL FORMULARIO DE PAGO.
   *
   * La clave pública es la DEL DUEÑO, no la de FreeWheel: en el split de
   * Mercado Pago la tarjeta se tokeniza con la clave pública de la cuenta que
   * cobra, y un token hecho con otra clave no sirve para cobrar en esa cuenta.
   * Por eso cambia de reserva en reserva.
   */
  async getCheckoutConfig(renterId: string, bookingId: string) {
    const booking = await this.findBookingWithUsers(bookingId);
    if (booking.renterId !== renterId) {
      throw new ForbiddenException("Only the renter can pay for this booking");
    }
    this.assertCurrency(booking);
    const owner = booking.owner;
    if (!owner.mpPublicKey || !owner.mpAccessTokenEnc) {
      throw this.ownerNotLinked();
    }
    const ticket = this.ticketOf(booking);
    const pagado = await this.capturedMinor(bookingId);
    return {
      provider: this.provider.name,
      publicKey: owner.mpPublicKey,
      currency: "ARS",
      amountMinor: ticket.totalMinor,
      amount: ticket.totalMinor / 100,
      description: this.descripcion(booking),
      payerEmail: booking.renter.email,
      contractAccepted: await this.contracts.hasAccepted(bookingId, "RENTER"),
      alreadyPaid: pagado >= ticket.totalMinor,
      deposit: {
        amountMinor: ticket.deposit.amountMinor,
        availableFrom: this.depositoDisponibleDesde(booking).toISOString(),
      },
      ticket,
    };
  }

  /**
   * EL PAGO DE UNA RESERVA: alquiler + cobertura, de una sola vez.
   *
   * La tarjeta llega tokenizada por el SDK de Mercado Pago del front (nunca el
   * número). El cobro se crea en la cuenta del DUEÑO y FreeWheel cobra su
   * parte —comisión y cobertura— como `application_fee`, en el mismo cobro.
   *
   * Dos condiciones antes de cobrar, y las dos son legales antes que técnicas:
   *   · quien alquila ACEPTÓ el contrato vigente. Nadie paga bajo condiciones
   *     que no aceptó.
   *   · el importe sale de los precios congelados de la reserva, nunca del
   *     cliente: lo que manda el front como importe se ignora.
   *
   * Contesta el resultado en el acto: Mercado Pago aprueba o rechaza en la
   * misma llamada. Un pago "en revisión" se resuelve después por el aviso.
   */
  async createCheckout(
    renterId: string,
    bookingId: string,
    ctx: PaymentContext,
    card: CardPaymentInput,
  ) {
    const booking = await this.findBookingWithUsers(bookingId);
    if (booking.renterId !== renterId) {
      throw new ForbiddenException("Only the renter can pay for this booking");
    }
    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(
        "Payments can only be made on accepted bookings",
      );
    }
    if (!(await this.contracts.hasAccepted(bookingId, "RENTER"))) {
      throw new ConflictException({
        statusCode: 409,
        code: "CONTRACT_NOT_ACCEPTED",
        message:
          "Antes de pagar tenés que aceptar el contrato de la reserva " +
          "(POST /contracts/bookings/:bookingId/accept).",
      });
    }
    this.assertCurrency(booking);
    await this.assertSinProveedorViejo(bookingId);

    const totalMinor = this.amountForKind(booking, "CHECKOUT");
    if ((await this.capturedMinor(bookingId)) >= totalMinor) {
      throw new ConflictException({
        statusCode: 409,
        code: "ALREADY_PAID",
        message: "Esta reserva ya está paga.",
      });
    }
    const enCurso = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.CHECKOUT,
        status: { in: OPEN_RECORD_STATUSES },
      },
    });
    if (enCurso) {
      // Un pago en revisión puede terminar aprobado: cobrar otro encima sería
      // cobrar dos veces la misma reserva.
      throw new ConflictException({
        statusCode: 409,
        code: "PAYMENT_IN_PROCESS",
        message:
          "Ya hay un pago de esta reserva en revisión. Esperá a que se " +
          "resuelva antes de intentar con otra tarjeta.",
        paymentId: enCurso.providerPaymentId,
      });
    }

    const comision = this.aMinor(booking.platformFeeSnapshot);
    const cobertura = this.aMinor(booking.insuranceSnapshot);
    return this.crearPago(booking, "CHECKOUT", {
      amountMinor: totalMinor,
      applicationFeeMinor: comision + cobertura,
      capture: true,
      card,
      ctx,
    });
  }

  /**
   * DEPRECADO: la seña ya no se cobra aparte. Se mantiene como alias del cobro
   * único para que una llamada vieja no se rompa: la primera llamada que
   * hacía ahora cobra todo, con la misma tarjeta.
   */
  createSenaIntent(
    renterId: string,
    bookingId: string,
    ctx: PaymentContext,
    card: CardPaymentInput,
  ) {
    return this.createCheckout(renterId, bookingId, ctx, card);
  }

  /** DEPRECADO: ya no hay saldo aparte. */
  createBalanceIntent(): never {
    throw new ConflictException({
      statusCode: 409,
      code: "PAYMENT_IS_SINGLE",
      message:
        "El pago de una reserva es uno solo: usá POST " +
        "/payments/bookings/:bookingId/checkout.",
    });
  }

  // ── El depósito en garantía ────────────────────────────────────────────

  /**
   * AUTORIZAR EL DEPÓSITO: una reserva de fondos en la tarjeta de quien
   * alquila, que se captura solo si hay un daño.
   *
   * ── Por qué lo hace la persona y no el servidor ─────────────────────────
   * Con Mercado Pago no se puede cobrar una tarjeta guardada sin la persona
   * presente: cada cobro necesita un token nuevo, y el token lo arma el
   * formulario con el código de seguridad. Así que el depósito se autoriza
   * desde el front, en un paso propio.
   *
   * ── Por qué cerca del retiro ────────────────────────────────────────────
   * Una reserva de fondos vale 7 días y después Mercado Pago la cancela sola.
   * Autorizarla al pagar una reserva de dentro de un mes sería autorizar algo
   * que se cae antes de que nadie retire el auto. Por eso se habilita recién
   * DEPOSIT_AUTH_WINDOW_HOURS antes del retiro (48 por omisión).
   *
   * La cuenta que cobra es la del dueño y sin comisión: si hay que capturar
   * algo por un daño, es una indemnización para él, no una venta.
   */
  async createDepositHold(
    renterId: string,
    bookingId: string,
    ctx: PaymentContext,
    card: CardPaymentInput,
  ) {
    const booking = await this.findBookingWithUsers(bookingId);
    if (booking.renterId !== renterId) {
      throw new ForbiddenException("Only the renter can pay for this booking");
    }
    if (
      booking.status !== BookingStatus.ACCEPTED &&
      booking.status !== BookingStatus.READY_FOR_PICKUP
    ) {
      throw new BadRequestException(
        "The deposit can only be authorized before the pickup",
      );
    }
    if (booking.paymentStatus !== PaymentStatus.FULLY_PAID) {
      throw new ConflictException({
        statusCode: 409,
        code: "CHECKOUT_NOT_PAID",
        message:
          "Primero hay que pagar la reserva; después se autoriza el depósito.",
      });
    }
    this.assertCurrency(booking);

    const desde = this.depositoDisponibleDesde(booking);
    if (new Date() < desde) {
      throw new ConflictException({
        statusCode: 409,
        code: "DEPOSIT_TOO_EARLY",
        message:
          "El depósito se autoriza cerca del retiro: una reserva de fondos " +
          "vale 7 días, y autorizada antes se caería antes de usar el auto.",
        availableFrom: desde.toISOString(),
      });
    }

    const vigente = await this.depositoVigente(bookingId);
    if (vigente) {
      throw new ConflictException({
        statusCode: 409,
        code: "DEPOSIT_ALREADY_AUTHORIZED",
        message: "El depósito de esta reserva ya está autorizado.",
        expiresAt: booking.depositHoldExpiresAt?.toISOString() ?? null,
      });
    }

    return this.crearPago(booking, "DEPOSIT_HOLD", {
      amountMinor: this.amountForKind(booking, "DEPOSIT_HOLD"),
      applicationFeeMinor: 0,
      capture: false,
      card,
      ctx,
    });
  }

  /**
   * ¿HAY UN DEPÓSITO AUTORIZADO QUE ALCANCE PARA ENTREGAR EL AUTO?
   *
   * Lo pregunta el dueño al marcar el auto listo para retirar. Con Mercado
   * Pago el servidor no puede autorizarlo solo (ver createDepositHold), así
   * que acá solo se mira: si no hay uno vigente, la respuesta le pide a quien
   * alquila que lo autorice.
   */
  async authorizeDepositForPickup(bookingId: string, _actorId: string) {
    const vigente = await this.depositoVigente(bookingId);
    return { authorized: Boolean(vigente), requiresRenterAction: !vigente };
  }

  async assertReadyForPickup(bookingId: string): Promise<void> {
    const booking = await this.findBooking(bookingId);
    if (booking.paymentStatus !== PaymentStatus.FULLY_PAID) {
      throw new BadRequestException({
        statusCode: 400,
        code: "CHECKOUT_NOT_PAID",
        message: "La reserva tiene que estar paga antes del retiro.",
      });
    }
    if (!(await this.depositoVigente(bookingId))) {
      throw new ConflictException({
        statusCode: 409,
        code: "DEPOSIT_AUTHORIZATION_REQUIRED",
        message:
          "El depósito en garantía no está autorizado. Quien alquila tiene " +
          "que autorizarlo desde la reserva (POST /payments/bookings/:id/deposit-hold).",
      });
    }
  }

  /** Un depósito autorizado y todavía no vencido, si lo hay. */
  private async depositoVigente(bookingId: string) {
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
      orderBy: { createdAt: "desc" },
    });
    if (!hold) return null;
    const booking = await this.findBooking(bookingId);
    if (
      booking.depositHoldExpiresAt &&
      booking.depositHoldExpiresAt < new Date()
    ) {
      return null;
    }
    return hold;
  }

  private depositoDisponibleDesde(booking: Booking): Date {
    const horas = Number.parseFloat(
      this.config.get<string>("DEPOSIT_AUTH_WINDOW_HOURS") ?? "",
    );
    const ventana =
      Number.isFinite(horas) && horas > 0
        ? horas
        : HORAS_DE_AUTORIZACION_POR_DEFECTO;
    return new Date(booking.startDate.getTime() - ventana * 3_600_000);
  }

  /**
   * CREA UN COBRO EN LA CUENTA DEL DUEÑO Y LO REGISTRA.
   *
   * La clave de idempotencia lleva el token de la tarjeta: cada intento con
   * una tarjeta nueva es una operación nueva, pero el mismo pedido repetido
   * (un reintento del front, un corte de red) devuelve el mismo cobro en vez
   * de cobrar dos veces.
   */
  private async crearPago(
    booking: BookingWithUsers,
    kind: PaymentRecordKindLike,
    opts: {
      amountMinor: number;
      applicationFeeMinor: number;
      capture: boolean;
      card: CardPaymentInput;
      ctx: PaymentContext;
    },
  ) {
    const collector = await this.collectorFor(booking.owner);
    const huella = createHash("sha256")
      .update(opts.card.token)
      .digest("hex")
      .slice(0, 24);
    const idempotencyKey = `fw_${booking.id}_${kind.toLowerCase()}_${opts.amountMinor}_${huella}`;

    const resultado = await this.provider.createPayment({
      bookingId: booking.id,
      kind,
      amountMinor: opts.amountMinor,
      currency: booking.currency,
      applicationFeeMinor: opts.applicationFeeMinor,
      capture: opts.capture,
      card: {
        ...opts.card,
        payer: {
          ...opts.card.payer,
          firstName: opts.card.payer.firstName ?? booking.renter.firstName,
          lastName: opts.card.payer.lastName ?? booking.renter.lastName,
        },
      },
      collector,
      description:
        kind === "DEPOSIT_HOLD"
          ? `Depósito en garantía — ${this.descripcion(booking)}`
          : this.descripcion(booking),
      externalReference: booking.id,
      notificationUrl: this.notificationUrl(),
      statementDescriptor:
        this.config.get<string>("MP_STATEMENT_DESCRIPTOR") ??
        DESCRIPTOR_POR_DEFECTO,
      metadata: { renter_id: booking.renterId, owner_id: booking.ownerId },
      items: [
        {
          id: booking.listingId,
          title:
            kind === "DEPOSIT_HOLD"
              ? "Depósito en garantía"
              : `Alquiler de ${this.vehicleLabel(booking)}`,
          description: this.descripcion(booking),
          quantity: 1,
          unitPriceMinor: opts.amountMinor,
          categoryId: "services",
        },
      ],
      idempotencyKey,
    });

    // UPSERT Y NO CREATE: con la misma clave de idempotencia, Mercado Pago
    // devuelve el MISMO pago, y crear una segunda fila con el mismo id del
    // procesador rompería la unicidad y dejaría la reserva sin poder pagarse.
    const datos = {
      bookingId: booking.id,
      userId: booking.renterId,
      kind: kind as PaymentRecordKind,
      status: PaymentRecordStatus.REQUIRES_ACTION,
      provider: this.provider.name,
      providerId: resultado.id,
      providerPaymentId: resultado.id,
      collectorId: collector.userId,
      amount: opts.amountMinor / 100,
      amountMinor: opts.amountMinor,
      applicationFeeMinor: opts.applicationFeeMinor,
      currency: booking.currency,
      initiatedIp: opts.ctx.ip ?? null,
      initiatedUserAgent: opts.ctx.userAgent?.slice(0, 500) ?? null,
      metadata: {
        renterId: booking.renterId,
        ownerId: booking.ownerId,
        installments: opts.card.installments,
      } as Prisma.InputJsonValue,
    };
    const record = await this.prisma.paymentRecord.upsert({
      where: { providerPaymentId: resultado.id },
      create: datos,
      update: {},
    });

    await this.recordEvent({
      record,
      bookingId: booking.id,
      actorId: booking.renterId,
      source: "api",
      type: `${kind.toLowerCase()}.payment.created`,
      status: PaymentRecordStatus.REQUIRES_ACTION,
      amountMinor: opts.amountMinor,
      currency: booking.currency,
      ip: opts.ctx.ip,
      userAgent: opts.ctx.userAgent,
    });
    await this.auditLog.create({
      actorId: booking.renterId,
      targetUserId: booking.ownerId,
      action: `payment.${kind.toLowerCase()}.created`,
      entityType: "Booking",
      entityId: booking.id,
      metadata: {
        paymentId: resultado.id,
        amountMinor: opts.amountMinor,
        status: resultado.status,
      },
    });

    const aplicado = await this.aplicarResultado(record, resultado, {
      source: "api",
    });
    const actualizado = await this.findBooking(booking.id);

    return {
      bookingId: booking.id,
      kind,
      paymentId: resultado.id,
      status: resultado.status,
      statusDetail: resultado.statusDetail,
      approved:
        resultado.status === "approved" || resultado.status === "authorized",
      message:
        resultado.status === "rejected"
          ? mensajeDelMotivo(resultado.statusDetail)
          : resultado.status === "in_process" || resultado.status === "pending"
            ? (mensajeDelMotivo(resultado.statusDetail) ??
              "El pago quedó en revisión. Te avisamos cuando se resuelva.")
            : null,
      amountMinor: opts.amountMinor,
      currency: booking.currency,
      recordStatus: aplicado.status,
      bookingPaymentStatus: actualizado.paymentStatus,
      depositExpiresAt: actualizado.depositHoldExpiresAt,
      ticket: this.ticketOf(actualizado),
    };
  }

  // ── El estado de un cobro: una sola máquina, para todos los caminos ─────

  /**
   * APLICA LO QUE DICE EL PROCESADOR SOBRE UN COBRO.
   *
   * Es el ÚNICO lugar que cambia el estado de un cobro, y lo usan los tres
   * caminos: la respuesta al crearlo, el aviso de Mercado Pago y la
   * conciliación diaria. Tener uno solo es lo que garantiza que los tres
   * terminen igual.
   *
   * Lo que se aplica es el estado ACTUAL que devuelve la API, no lo que dice
   * un aviso: un aviso viejo que llega tarde no puede pisar uno nuevo. Y un
   * cobro nunca retrocede (un capturado no vuelve a "en revisión").
   */
  private async aplicarResultado(
    record: PaymentRecord,
    resultado: PaymentResult,
    opts: { source: "api" | "webhook" | "system"; eventId?: string | null },
  ): Promise<PaymentRecord> {
    const nuevo = this.estadoLocal(record.kind, resultado);
    if (
      RANGO[nuevo] < RANGO[record.status] &&
      !OPEN_RECORD_STATUSES.includes(record.status)
    ) {
      return record;
    }
    const cambio = nuevo !== record.status;
    const bookingId = record.bookingId;

    // El importe que Mercado Pago dice haber cobrado contra el que la reserva
    // esperaba. Un desajuste es una señal de manipulación: no se revierte solo
    // —la plata ya entró— pero queda gritado en el log y en el registro.
    if (
      record.amountMinor != null &&
      resultado.amountMinor > 0 &&
      resultado.amountMinor !== record.amountMinor
    ) {
      this.logger.error(
        `el cobro ${resultado.id} es por ${resultado.amountMinor} y la ` +
          `reserva ${bookingId} esperaba ${record.amountMinor}`,
      );
    }

    const ahora = new Date();
    const actualizado = await this.prisma.$transaction(async (tx) => {
      const fila = await tx.paymentRecord.update({
        where: { id: record.id },
        data: {
          status: nuevo,
          ...cardColumns(resultado),
          failureCode:
            resultado.failure?.code ??
            (nuevo === PaymentRecordStatus.FAILED
              ? resultado.statusDetail
              : null),
          failureMessage: resultado.failure?.message ?? null,
          refundedAmountMinor: Math.max(
            record.refundedAmountMinor,
            resultado.refundedMinor,
          ),
          ...(nuevo === PaymentRecordStatus.CAPTURED && !record.capturedAt
            ? { capturedAt: ahora, paidAt: ahora }
            : {}),
          ...(nuevo === PaymentRecordStatus.RELEASED && !record.releasedAt
            ? { releasedAt: ahora }
            : {}),
          ...(nuevo === PaymentRecordStatus.DISPUTED && !record.disputedAt
            ? { disputedAt: ahora }
            : {}),
          ...((nuevo === PaymentRecordStatus.REFUNDED ||
            nuevo === PaymentRecordStatus.PARTIALLY_REFUNDED) &&
          !record.refundedAt
            ? { refundedAt: ahora }
            : {}),
        },
      });

      if (!bookingId || !cambio) return fila;

      if (record.kind === PaymentRecordKind.CHECKOUT) {
        if (nuevo === PaymentRecordStatus.CAPTURED) {
          await tx.booking.update({
            where: { id: bookingId },
            data: {
              paymentStatus: PaymentStatus.FULLY_PAID,
              paidAt: ahora,
              checkoutPaymentId: resultado.id,
            },
          });
        } else if (nuevo === PaymentRecordStatus.FAILED) {
          const booking = await tx.booking.findUnique({
            where: { id: bookingId },
            select: { paymentStatus: true },
          });
          if (booking?.paymentStatus !== PaymentStatus.FULLY_PAID) {
            await tx.booking.update({
              where: { id: bookingId },
              data: { paymentStatus: PaymentStatus.FAILED },
            });
          }
        } else if (nuevo === PaymentRecordStatus.REFUNDED) {
          await tx.booking.update({
            where: { id: bookingId },
            data: { paymentStatus: PaymentStatus.REFUNDED, refundedAt: ahora },
          });
        }
      } else if (
        record.kind === PaymentRecordKind.DEPOSIT_HOLD &&
        nuevo === PaymentRecordStatus.AUTHORIZED
      ) {
        await tx.booking.update({
          where: { id: bookingId },
          data: {
            depositPaymentId: resultado.id,
            depositHoldExpiresAt: resultado.captureBefore,
          },
        });
      }

      if (nuevo === PaymentRecordStatus.DISPUTED) {
        await tx.booking.update({
          where: { id: bookingId },
          data: { paymentStatus: PaymentStatus.DISPUTED },
        });
      }
      return fila;
    });

    if (!cambio) return actualizado;

    await this.recordEvent({
      record: actualizado,
      bookingId,
      source: opts.source,
      type: `payment.${resultado.status}`,
      status: nuevo,
      amountMinor: resultado.capturedMinor ?? resultado.amountMinor,
      currency: record.currency,
      providerEventId: opts.eventId ?? null,
      payload: {
        status: resultado.status,
        statusDetail: resultado.statusDetail,
      },
    });

    if (
      bookingId &&
      nuevo === PaymentRecordStatus.CAPTURED &&
      record.kind === PaymentRecordKind.CHECKOUT
    ) {
      await this.ensureFundsJournal(bookingId);
      await this.auditLog.create({
        action: "payment.checkout.approved",
        entityType: "Booking",
        entityId: bookingId,
        metadata: { paymentId: resultado.id },
      });
      await this.avisarDelPago(bookingId, record.kind, record.amount);
    }

    if (nuevo === PaymentRecordStatus.DISPUTED) {
      this.logger.error(
        `DISPUTA sobre el cobro ${resultado.id} (reserva ${bookingId}): ` +
          `${resultado.status}. La liquidación de la reserva queda frenada.`,
      );
      await this.auditLog.create({
        targetUserId: record.userId ?? undefined,
        action: "payment.dispute.opened",
        entityType: "Booking",
        entityId: bookingId ?? "",
        metadata: { paymentId: resultado.id, status: resultado.status },
      });
    }

    return actualizado;
  }

  /** Cómo se llama, acá, cada estado de Mercado Pago. */
  private estadoLocal(
    kind: PaymentRecordKind | null,
    resultado: PaymentResult,
  ): PaymentRecordStatus {
    const deposito = kind === PaymentRecordKind.DEPOSIT_HOLD;
    const mapa: Record<ProcessorPaymentStatus, PaymentRecordStatus> = {
      approved:
        resultado.refundedMinor > 0
          ? PaymentRecordStatus.PARTIALLY_REFUNDED
          : PaymentRecordStatus.CAPTURED,
      authorized: PaymentRecordStatus.AUTHORIZED,
      in_process: PaymentRecordStatus.PROCESSING,
      pending:
        resultado.statusDetail === "pending_challenge"
          ? PaymentRecordStatus.REQUIRES_ACTION
          : PaymentRecordStatus.PROCESSING,
      rejected: PaymentRecordStatus.FAILED,
      // Cancelar una reserva de fondos ES soltarla: para quien alquiló, su
      // plata se desbloqueó. Distinguirlo importa en el historial.
      cancelled: deposito
        ? PaymentRecordStatus.RELEASED
        : PaymentRecordStatus.CANCELLED,
      refunded: PaymentRecordStatus.REFUNDED,
      charged_back: PaymentRecordStatus.DISPUTED,
      in_mediation: PaymentRecordStatus.DISPUTED,
    };
    return mapa[resultado.status];
  }

  // ── Avisos de Mercado Pago ─────────────────────────────────────────────

  /**
   * UN AVISO DE MERCADO PAGO.
   *
   * La firma se verifica siempre. Pero aunque viniera bien firmado, el aviso
   * es solo una pista: dice QUÉ cambió, no CÓMO quedó. El estado se le
   * pregunta a la API con el token del dueño, y es eso lo que se aplica. Así
   * un aviso falso, repetido o fuera de orden no puede inventar un cobro.
   */
  async handleNotification(input: {
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, unknown>;
    body: unknown;
  }) {
    const aviso = this.provider.parseNotification({
      body: input.body,
      query: input.query,
    });
    const cabecera = (nombre: string) => {
      const valor = input.headers[nombre];
      return Array.isArray(valor) ? valor[0] : (valor ?? null);
    };

    try {
      this.provider.verifyNotificationSignature({
        signatureHeader: cabecera("x-signature"),
        requestId: cabecera("x-request-id"),
        dataId: aviso.dataId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`aviso de Mercado Pago rechazado: ${message}`);
      throw new BadRequestException({
        statusCode: 400,
        code: "INVALID_NOTIFICATION_SIGNATURE",
        message: "Aviso sin firma válida.",
      });
    }

    // UN AVISO DEL MODO REAL LLEGANDO A UN DEPLOY DE PRUEBA SE DESCARTA.
    // Algo está cruzado —las credenciales, o la URL de avisos de la cuenta
    // real apuntada acá—, y procesarlo movería plata de verdad sobre reservas
    // de mentira. Se contesta 200 para que Mercado Pago no reintente.
    if (aviso.liveMode === true && !this.provider.liveMode) {
      this.logger.error(
        `aviso de PRODUCCIÓN (${aviso.topic} ${aviso.dataId}) recibido por un ` +
          "deploy en modo de prueba: descartado. Revisar a dónde apuntan los " +
          "avisos de la aplicación de Mercado Pago.",
      );
      return { received: true, ignored: "livemode_mismatch" as const };
    }

    if (!aviso.dataId) {
      return { received: true, ignored: "no_data_id" as const };
    }

    // La unicidad del id es la que descarta duplicados, y se apoya en la
    // base: dos entregas del mismo aviso llegando a la vez pasaban las dos
    // por un chequeo previo.
    const eventId = `mp:${aviso.topic}:${aviso.notificationId ?? aviso.dataId}:${aviso.action ?? ""}`;
    try {
      await this.prisma.processorEvent.create({
        data: {
          eventId,
          type: `${aviso.topic}${aviso.action ? `.${aviso.action}` : ""}`,
          payload: aviso as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return { received: true, duplicate: true as const, topic: aviso.topic };
      }
      throw error;
    }

    switch (aviso.topic) {
      case "payment":
        await this.onPaymentNotification(
          aviso.dataId,
          aviso.collectorUserId,
          eventId,
        );
        break;
      case "chargebacks":
        await this.onChargebackNotification(
          aviso.dataId,
          aviso.collectorUserId,
          eventId,
        );
        break;
      case "mp-connect":
        if (aviso.action === "application.deauthorized") {
          await this.onDeauthorized(aviso.collectorUserId ?? aviso.dataId);
        }
        break;
      default:
        this.logger.debug(`aviso ${aviso.topic} recibido y no aplicado`);
    }

    await this.prisma.processorEvent.update({
      where: { eventId },
      data: { processedAt: new Date() },
    });
    return { received: true, duplicate: false as const, topic: aviso.topic };
  }

  private async onPaymentNotification(
    paymentId: string,
    collectorUserId: string | null,
    eventId: string,
  ) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { providerPaymentId: paymentId },
    });
    if (!record) {
      await this.adoptarPagoHuerfano(paymentId, collectorUserId, eventId);
      return;
    }
    await this.refrescarCobro(record, "webhook", eventId);
  }

  /**
   * CONSULTA UN COBRO A LA API Y APLICA LO QUE DIGA.
   *
   * No lanza: si la API no contesta, el cobro queda como estaba y la
   * conciliación diaria lo vuelve a intentar. Una caída momentánea de Mercado
   * Pago no puede dejar un aviso sin aplicar para siempre.
   */
  private async refrescarCobro(
    record: PaymentRecord,
    source: "webhook" | "system",
    eventId?: string,
  ): Promise<void> {
    if (!record.providerPaymentId || !record.bookingId) return;
    try {
      const booking = await this.findBookingWithUsers(record.bookingId);
      const collector = await this.collectorFor(booking.owner, record);
      const resultado = await this.provider.getPayment(
        collector,
        record.providerPaymentId,
      );
      await this.aplicarResultado(record, resultado, { source, eventId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `no se pudo consultar el cobro ${record.providerPaymentId}: ${message}`,
      );
    }
  }

  /**
   * UN COBRO QUE MERCADO PAGO HIZO Y NOSOTROS NO SABEMOS.
   *
   * Pasa cuando el pedido llegó a Mercado Pago pero la respuesta se perdió
   * (un corte de red, un timeout). El cobro existe y la persona pagó: si el
   * aviso se ignorara, la reserva quedaría impaga con la plata cobrada.
   *
   * Se adopta solo si todo cierra: la cuenta que cobró es la de un dueño
   * vinculado, la referencia es una reserva de ESE dueño y el tramo es uno
   * que conocemos. Si algo no cierra, se deja anotado y no se toca nada.
   */
  private async adoptarPagoHuerfano(
    paymentId: string,
    collectorUserId: string | null,
    eventId: string,
  ): Promise<void> {
    if (!collectorUserId) return;
    const owner = await this.prisma.user.findUnique({
      where: { mpUserId: collectorUserId },
    });
    if (!owner) return;

    let resultado: PaymentResult;
    try {
      resultado = await this.provider.getPayment(
        await this.collectorFor(owner),
        paymentId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `no se pudo consultar el cobro huérfano ${paymentId}: ${message}`,
      );
      return;
    }

    const kind =
      resultado.kind === "CHECKOUT" || resultado.kind === "DEPOSIT_HOLD"
        ? resultado.kind
        : null;
    const booking = resultado.externalReference
      ? await this.prisma.booking.findUnique({
          where: { id: resultado.externalReference },
        })
      : null;
    if (!kind || !booking || booking.ownerId !== owner.id) {
      this.logger.warn(
        `cobro ${paymentId} de la cuenta ${collectorUserId} sin reserva ` +
          "reconocible: no se adopta",
      );
      return;
    }

    const esperado = this.amountForKind(booking, kind);
    const record = await this.prisma.paymentRecord.upsert({
      where: { providerPaymentId: paymentId },
      create: {
        bookingId: booking.id,
        userId: booking.renterId,
        kind: kind as PaymentRecordKind,
        status: PaymentRecordStatus.REQUIRES_ACTION,
        provider: this.provider.name,
        providerId: paymentId,
        providerPaymentId: paymentId,
        collectorId: collectorUserId,
        amount: esperado / 100,
        amountMinor: esperado,
        applicationFeeMinor:
          kind === "CHECKOUT"
            ? this.aMinor(booking.platformFeeSnapshot) +
              this.aMinor(booking.insuranceSnapshot)
            : 0,
        currency: booking.currency,
        metadata: { adopted: true } as Prisma.InputJsonValue,
      },
      update: {},
    });
    this.logger.warn(
      `cobro ${paymentId} adoptado para la reserva ${booking.id}: la respuesta ` +
        "original nunca llegó",
    );
    await this.aplicarResultado(record, resultado, {
      source: "webhook",
      eventId,
    });
  }

  private async onChargebackNotification(
    chargebackId: string,
    collectorUserId: string | null,
    eventId: string,
  ) {
    if (!collectorUserId) return;
    const owner = await this.prisma.user.findUnique({
      where: { mpUserId: collectorUserId },
    });
    if (!owner) return;
    try {
      const contracargo = await this.provider.getChargeback(
        await this.collectorFor(owner),
        chargebackId,
      );
      for (const paymentId of contracargo.paymentIds) {
        const record = await this.prisma.paymentRecord.findUnique({
          where: { providerPaymentId: paymentId },
        });
        if (record) await this.refrescarCobro(record, "webhook", eventId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `no se pudo leer el contracargo ${chargebackId}: ${message}`,
      );
    }
  }

  /**
   * EL DUEÑO DESVINCULÓ SU CUENTA DESDE MERCADO PAGO.
   *
   * No se puede impedir: es su cuenta. Lo que sí se hace es borrar sus
   * credenciales (ya no sirven) y gritar si tenía cobros activos, porque esos
   * ya no se pueden devolver, capturar ni soltar desde acá: hay que hacerlo a
   * mano desde el panel de Mercado Pago.
   */
  private async onDeauthorized(mpUserId: string | null): Promise<void> {
    if (!mpUserId) return;
    const owner = await this.prisma.user.findUnique({
      where: { mpUserId },
    });
    if (!owner) return;
    await this.prisma.user.update({
      where: { id: owner.id },
      data: {
        mpAccessTokenEnc: null,
        mpRefreshTokenEnc: null,
        mpTokenExpiresAt: null,
      },
    });
    const activos = await this.prisma.paymentRecord.count({
      where: {
        collectorId: mpUserId,
        status: {
          in: [PaymentRecordStatus.AUTHORIZED, ...OPEN_RECORD_STATUSES],
        },
      },
    });
    this.logger.error(
      `el dueño ${owner.id} desvinculó su cuenta de Mercado Pago` +
        (activos > 0
          ? ` con ${activos} cobros activos: gestionarlos a mano desde el panel`
          : ""),
    );
    await this.auditLog.create({
      targetUserId: owner.id,
      action: "payments.owner.deauthorized",
      entityType: "User",
      entityId: owner.id,
      metadata: { activePayments: activos },
    });
  }

  /**
   * LA CONCILIACIÓN: los cobros que quedaron sin resolver se le preguntan a
   * Mercado Pago. Lo corre el trabajo diario.
   *
   * Existe para que ningún cobro dependa de que un aviso llegue: un pago en
   * revisión que se aprueba mientras el servidor estaba caído, o una reserva
   * de fondos que Mercado Pago canceló sola a los 7 días, se ven igual.
   */
  async reconcilePendingPayments(now: Date = new Date()): Promise<number> {
    const hace10Min = new Date(now.getTime() - 10 * 60 * 1000);
    const pendientes = await this.prisma.paymentRecord.findMany({
      where: {
        provider: this.provider.name,
        providerPaymentId: { not: null },
        OR: [
          {
            status: { in: OPEN_RECORD_STATUSES },
            createdAt: { lt: hace10Min },
          },
          {
            status: PaymentRecordStatus.AUTHORIZED,
            booking: { depositHoldExpiresAt: { lt: now } },
          },
        ],
      },
      take: 200,
    });
    for (const record of pendientes) {
      await this.refrescarCobro(record, "system");
    }
    return pendientes.length;
  }

  // ── Estado ─────────────────────────────────────────────────────────────

  async getStatus(
    userId: string,
    bookingId: string,
    opts: { asAdmin?: boolean } = {},
  ) {
    const booking = opts.asAdmin
      ? await this.findBooking(bookingId)
      : await this.findBookingForParticipant(userId, bookingId);
    const records = await this.prisma.paymentRecord.findMany({
      where: { bookingId },
      orderBy: { createdAt: "asc" },
    });
    const pockets = await this.pockets(bookingId);
    const deposito = records
      .filter((r) => r.kind === PaymentRecordKind.DEPOSIT_HOLD)
      .at(-1);
    return {
      bookingId,
      provider: this.provider.name,
      paymentStatus: booking.paymentStatus,
      currency: booking.currency,
      total: booking.totalPriceSnapshot,
      sena: booking.senaAmountSnapshot,
      balance: booking.balanceAmountSnapshot,
      deposit: booking.depositSnapshot,
      commission: booking.platformFeeSnapshot,
      insurance: booking.insuranceSnapshot,
      ownerPayout: booking.ownerPayoutSnapshot,
      // Con el split no hay transferencia: el dueño cobra en el acto.
      ownerTransferId: booking.ownerTransferId,
      depositCapturedAmount: booking.depositCapturedAmount,
      depositHoldExpiresAt: booking.depositHoldExpiresAt,
      depositStatus: deposito?.status ?? null,
      depositAvailableFrom: this.depositoDisponibleDesde(booking).toISOString(),
      paidAt: booking.paidAt,
      refundedAt: booking.refundedAt,
      settledAt: booking.settledAt,
      inspectionEndsAt: booking.inspectionEndsAt,
      cancellation: booking.cancellationSettlement,
      ticket: this.ticketOf(booking),
      /** Lo que FreeWheel retiene a nombre de esta reserva (con el split, nada). */
      heldMinor: pockets,
      records: records.map((record) => publicRecord(record)),
    };
  }

  /**
   * LAS TARJETAS GUARDADAS. Con el split de Mercado Pago no hay: una tarjeta
   * se guarda en la cuenta que cobra, y acá cada reserva cobra en la cuenta
   * de un dueño distinto. La ruta queda para no romper al front que la usaba.
   */
  listSavedCards(_userId: string) {
    return {
      cards: [],
      supported: false,
      reason:
        "Con Mercado Pago cada reserva cobra en la cuenta de su dueño, así que " +
        "no hay tarjetas guardadas que sirvan para la próxima.",
    };
  }

  /** El ticket de una reserva, para mostrarlo antes de pagar. */
  async getTicket(userId: string, bookingId: string) {
    const booking = await this.findBookingForParticipant(userId, bookingId);
    return this.ticketOf(booking);
  }

  /** El ticket de una reserva, desde sus precios congelados. */
  ticketOf(booking: Booking): Ticket {
    const days = Math.max(
      1,
      Math.round(
        (booking.endDate.getTime() - booking.startDate.getTime()) / 86_400_000,
      ),
    );
    return buildTicket({
      currency: booking.currency,
      days,
      pricePerDay: booking.pricePerDaySnapshot,
      rentalSubtotal: booking.rentalSubtotalSnapshot,
      insurance: booking.insuranceSnapshot,
      commission: booking.platformFeeSnapshot,
      sena: booking.senaAmountSnapshot,
      deposit: booking.depositSnapshot,
    });
  }

  /**
   * Reintentar la liquidación a mano, desde el panel. No duplica nada: cada
   * paso de la liquidación es idempotente.
   */
  async resettle(actorId: string, bookingId: string) {
    const resultado = await this.settleBooking(bookingId, actorId);
    if (!resultado.settled) {
      throw new ConflictException({
        statusCode: 409,
        code: resultado.reason ?? "NOT_SETTLEABLE",
        message:
          "Esta reserva no se puede liquidar todavía: " +
          (resultado.reason ?? "no está en condiciones"),
      });
    }
    return { settled: true, bookingId };
  }

  // ── El libro ───────────────────────────────────────────────────────────

  /**
   * ASIENTA EL COBRO DE UNA RESERVA, tal como lo repartió el split.
   *
   * FreeWheel recibió su parte (comisión + cobertura) en su cuenta de Mercado
   * Pago: eso sí es de sus libros, y va a sus bolsillos. La parte del dueño
   * entró directo a la cuenta del dueño: NO es plata de FreeWheel, así que va
   * a las cuentas de orden del split, que la dejan anotada sin mezclarla.
   *
   * Idempotente: se puede llamar cuantas veces haga falta.
   */
  async ensureFundsJournal(
    bookingId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const clave = `funds:${bookingId}`;
    if (await this.ledger.exists(clave, db)) return;

    const booking = await db.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return;
    const checkout = await db.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.CHECKOUT,
        status: {
          in: [
            ...PAID_RECORD_STATUSES,
            PaymentRecordStatus.PARTIALLY_REFUNDED,
            PaymentRecordStatus.DISPUTED,
          ],
        },
      },
    });
    if (!checkout?.amountMinor) return;

    const comision = this.aMinor(booking.platformFeeSnapshot);
    const cobertura = this.aMinor(booking.insuranceSnapshot);
    const fee = comision + cobertura;
    const delDueno = checkout.amountMinor - fee;

    await this.ledger.post(
      {
        idempotencyKey: clave,
        type: "funds.split",
        description:
          "Cobro de la reserva repartido por Mercado Pago: comisión y " +
          "cobertura a FreeWheel, el resto directo al dueño",
        currency: booking.currency,
        bookingId,
        lines: [
          { account: Accounts.processorClearing(), amountMinor: -fee },
          { account: Accounts.platformCommission(), amountMinor: comision },
          { account: Accounts.insurancePayable(), amountMinor: cobertura },
          {
            account: Accounts.splitOwnerDirect(booking.ownerId),
            amountMinor: delDueno,
          },
          { account: Accounts.splitCollected(), amountMinor: -delDueno },
        ],
      },
      db,
    );
  }

  /**
   * Lo que FreeWheel retiene en los bolsillos de una reserva. Con el split
   * es siempre cero; queda para las reservas cobradas con el modelo anterior.
   */
  private async pockets(bookingId: string) {
    const [sena, rental, insurance] = await Promise.all([
      this.ledger.balance(Accounts.bookingSena(bookingId)),
      this.ledger.balance(Accounts.bookingRental(bookingId)),
      this.ledger.balance(Accounts.bookingInsurance(bookingId)),
    ]);
    return { sena, rental, insurance };
  }

  /** La comisión como fracción del alquiler, desde los precios congelados. */
  private commissionPct(booking: Booking): number {
    const alquiler = booking.rentalSubtotalSnapshot ?? 0;
    const comision = booking.platformFeeSnapshot ?? 0;
    return alquiler > 0 ? comision / alquiler : 0;
  }

  // ── Liquidación: cierre de la ventana de inspección ───────────────────

  /**
   * LIQUIDA UNA RESERVA: suelta el depósito o cobra de él lo aprobado por un
   * daño, y cierra la reserva.
   *
   * Con el split, al dueño no hay que transferirle nada: cobró en el momento
   * del pago. Lo único que queda para el cierre es el depósito.
   *
   * Solo se puede cuando la ventana de inspección se cerró sin reclamo, o el
   * reclamo quedó resuelto. Es IDEMPOTENTE: la puede pedir el cron, una de las
   * partes o un admin, y aunque la pidan a la vez se liquida una sola vez.
   */
  async settleBooking(
    bookingId: string,
    actorId: string | null,
    opts: { now?: Date } = {},
  ): Promise<{ settled: boolean; reason?: string }> {
    const now = opts.now ?? new Date();
    const booking = await this.findBookingWithUsers(bookingId);
    if (booking.settledAt) return { settled: true, reason: "ALREADY_SETTLED" };

    // UNA CONTRACARA BANCARIA FRENA TODO. Ojo con los dos "DISPUTED":
    // PaymentStatus.DISPUTED es el desconocimiento del cobro en el banco;
    // BookingStatus.DISPUTED, más abajo, es un reclamo por daños.
    if (booking.paymentStatus === PaymentStatus.DISPUTED) {
      return { settled: false, reason: "PAYMENT_DISPUTED" };
    }

    const claim = await this.prisma.damageClaim.findUnique({
      where: { bookingId },
    });
    const claimOpen =
      claim &&
      (claim.status === DamageClaimStatus.OPEN ||
        claim.status === DamageClaimStatus.CONTESTED);

    if (booking.status === BookingStatus.INSPECTION) {
      if (!booking.inspectionEndsAt || booking.inspectionEndsAt > now) {
        return { settled: false, reason: "INSPECTION_WINDOW_OPEN" };
      }
      if (claimOpen) return { settled: false, reason: "CLAIM_OPEN" };
    } else if (booking.status === BookingStatus.DISPUTED) {
      if (claimOpen || !claim) return { settled: false, reason: "CLAIM_OPEN" };
    } else {
      return { settled: false, reason: "NOT_RETURNED" };
    }

    await this.ensureFundsJournal(bookingId);

    // 1. El depósito: se cobra lo aprobado por un daño, o se suelta entero.
    const aprobado =
      claim &&
      (claim.status === DamageClaimStatus.ACCEPTED ||
        claim.status === DamageClaimStatus.RESOLVED)
        ? (claim.amountApprovedMinor ?? 0)
        : 0;
    if (aprobado > 0 && claim) {
      await this.captureDamage(
        bookingId,
        aprobado,
        `claim:${claim.id}`,
        actorId,
      );
    } else {
      await this.releaseDepositHold(bookingId, actorId);
    }

    // 2. Una reserva cobrada con el modelo anterior tiene plata retenida en
    //    sus bolsillos: se reparte como antes. Con el split están en cero.
    const { sena, rental, insurance } = await this.pockets(bookingId);
    if (sena + rental + insurance > 0) {
      const bruto = sena + rental;
      const comision = Math.round(bruto * this.commissionPct(booking));
      await this.ledger.post({
        idempotencyKey: `settle:${bookingId}`,
        type: "booking.settled",
        description:
          "Liquidación de una reserva cobrada con el modelo anterior",
        currency: booking.currency,
        bookingId,
        actorId,
        lines: [
          { account: Accounts.bookingSena(bookingId), amountMinor: -sena },
          { account: Accounts.bookingRental(bookingId), amountMinor: -rental },
          {
            account: Accounts.ownerPayable(booking.ownerId),
            amountMinor: bruto - comision,
          },
          { account: Accounts.platformCommission(), amountMinor: comision },
          {
            account: Accounts.bookingInsurance(bookingId),
            amountMinor: -insurance,
          },
          { account: Accounts.insurancePayable(), amountMinor: insurance },
        ],
      });
    }

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.COMPLETED, settledAt: now },
    });

    await this.auditLog.create({
      actorId: actorId ?? undefined,
      targetUserId: booking.ownerId,
      action: "booking.settled",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { damagesMinor: aprobado },
    });

    await this.payOwner(booking.owner, `settle:${bookingId}`, actorId);
    return { settled: true };
  }

  /**
   * LO QUE SE LE DEBE A UN DUEÑO POR FUERA DEL SPLIT.
   *
   * Con Mercado Pago el dueño cobra en el momento del pago, así que en el caso
   * normal no se le debe nada. Queda un saldo en su bolsillo solo en dos
   * casos: el ajuste de una cancelación con seña (ver money/split-refund.ts)
   * y las reservas del modelo anterior. El split no tiene transferencias, así
   * que ese saldo se paga por fuera y se registra con recordOwnerPayoutPaid.
   *
   * No lanza nunca: una deuda pendiente no puede frenar el cierre de nada.
   */
  async payOwner(
    owner: User,
    reference: string,
    _actorId: string | null,
  ): Promise<{ paidMinor: number; pending: boolean }> {
    const debido = await this.ledger.balance(Accounts.ownerPayable(owner.id));
    if (debido > 0) {
      this.logger.warn(
        `el dueño ${owner.id} tiene ${debido} a cobrar por fuera del split ` +
          `(${reference}): pagarlo por transferencia y registrarlo en ` +
          "POST /payments/admin/ledger/owners/:ownerId/payout",
      );
    }
    return { paidMinor: 0, pending: debido > 0 };
  }

  /**
   * Cuántos dueños tienen algo a cobrar por fuera del split. Lo corre el cron
   * para que el saldo pendiente aparezca en el log todos los días hasta que
   * alguien lo pague: con el split no hay transferencia automática.
   */
  async retryPendingPayouts(): Promise<number> {
    const saldos = await this.ledger.balances({ prefix: "owner:" });
    const pendientes = saldos.filter((s) => s.balanceMinor > 0);
    if (pendientes.length > 0) {
      this.logger.warn(
        `${pendientes.length} dueño(s) con saldo a cobrar por fuera del split`,
      );
    }
    return 0;
  }

  /** Suelta la reserva de fondos del depósito, si la había. */
  private async releaseDepositHold(bookingId: string, actorId: string | null) {
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (!hold?.providerPaymentId) return;

    const booking = await this.findBookingWithUsers(bookingId);
    let resultado: PaymentResult | null = null;
    try {
      resultado = await this.provider.cancelPayment(
        await this.collectorFor(booking.owner, hold),
        hold.providerPaymentId,
        `fw_release_${hold.id}`,
      );
    } catch (error) {
      // Una reserva que ya venció no se puede cancelar: Mercado Pago la soltó
      // sola. Para quien alquiló el resultado es el mismo.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `no se pudo soltar el depósito de ${bookingId}: ${message}`,
      );
    }

    const updated = await this.prisma.paymentRecord.update({
      where: { id: hold.id },
      data: { status: PaymentRecordStatus.RELEASED, releasedAt: new Date() },
    });
    await this.recordEvent({
      record: updated,
      bookingId,
      actorId,
      source: "api",
      type: "hold.released",
      status: PaymentRecordStatus.RELEASED,
      amountMinor: hold.amountMinor,
      currency: hold.currency,
      payload: resultado
        ? { status: resultado.status }
        : { alreadyExpired: true },
    });
    await this.avisarDeLaLiberacion(bookingId, hold);
  }

  /**
   * COBRAR UN DAÑO DEL DEPÓSITO.
   *
   * Nunca más de lo retenido, y solo mientras la reserva de fondos siga viva.
   * Lo capturado entra a la cuenta del DUEÑO (el depósito se autorizó en su
   * cuenta y sin comisión): es una indemnización, no un alquiler. Devuelve lo
   * que efectivamente se cobró; la diferencia con lo aprobado es un reclamo
   * que se sigue por fuera de la plataforma.
   */
  async captureDamage(
    bookingId: string,
    approvedMinor: number,
    reference: string,
    actorId: string | null,
    ctx: PaymentContext = {},
  ): Promise<{ capturedMinor: number; reason?: string }> {
    const booking = await this.findBookingWithUsers(bookingId);
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (!hold?.providerPaymentId) {
      return { capturedMinor: 0, reason: "DEPOSIT_HOLD_NOT_AVAILABLE" };
    }
    if (
      booking.depositHoldExpiresAt &&
      booking.depositHoldExpiresAt < new Date()
    ) {
      return { capturedMinor: 0, reason: "DEPOSIT_HOLD_EXPIRED" };
    }

    const retenido = hold.amountMinor ?? 0;
    const monto = Math.min(Math.max(0, Math.trunc(approvedMinor)), retenido);
    if (monto <= 0) {
      await this.releaseDepositHold(bookingId, actorId);
      return { capturedMinor: 0 };
    }

    await this.provider.capturePayment(
      await this.collectorFor(booking.owner, hold),
      hold.providerPaymentId,
      monto,
      `fw_capture_${hold.id}_${monto}`,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const actualizado = await tx.paymentRecord.update({
        where: { id: hold.id },
        data: {
          status: PaymentRecordStatus.CAPTURED,
          amount: monto / 100,
          amountMinor: monto,
          capturedAt: new Date(),
          paidAt: new Date(),
          metadata: {
            ...((hold.metadata as Record<string, unknown> | null) ?? {}),
            depositHeldMinor: retenido,
            captureReference: reference,
          } as Prisma.InputJsonValue,
        },
      });
      await tx.booking.update({
        where: { id: bookingId },
        data: { depositCapturedAmount: monto / 100 },
      });
      // No es plata de FreeWheel: entró a la cuenta del dueño. Queda en las
      // cuentas de orden del split para que la reserva se explique entera.
      await this.ledger.post(
        {
          idempotencyKey: `damage:${bookingId}`,
          type: "deposit.captured.split",
          description: "Cobro de un daño del depósito, directo al dueño",
          currency: hold.currency,
          bookingId,
          actorId,
          lines: [
            {
              account: Accounts.splitOwnerDirect(booking.ownerId),
              amountMinor: monto,
            },
            { account: Accounts.splitCollected(), amountMinor: -monto },
          ],
        },
        tx,
      );
      return actualizado;
    });

    await this.recordEvent({
      record: updated,
      bookingId,
      actorId,
      source: "api",
      type: "hold.captured",
      status: PaymentRecordStatus.CAPTURED,
      amountMinor: monto,
      currency: hold.currency,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      payload: { reference, heldMinor: retenido },
    });
    await this.avisarDeLaCaptura(bookingId, monto, retenido, reference);
    return { capturedMinor: monto };
  }

  /**
   * COBRAR UN DAÑO SIN RECLAMO (solo admin): la vía directa que existía antes
   * de los reclamos. Se mantiene para casos que un admin ya resolvió por fuera.
   */
  async captureDeposit(
    actorId: string,
    bookingId: string,
    amountMinor: number,
    reason: string,
    ctx: PaymentContext = {},
  ) {
    const booking = await this.findBooking(bookingId);
    if (actorId === booking.ownerId || actorId === booking.renterId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "SELF_REVIEW_FORBIDDEN",
        message:
          "Un administrador no puede resolver plata de una reserva propia.",
      });
    }
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (!hold) {
      throw new BadRequestException({
        statusCode: 400,
        code: "DEPOSIT_HOLD_NOT_AVAILABLE",
        message:
          "Esta reserva no tiene un depósito retenido para cobrar. Puede que " +
          "ya se haya soltado o que nunca se haya autorizado.",
      });
    }
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: "INVALID_AMOUNT",
        message: "El importe a cobrar tiene que ser un número positivo.",
      });
    }
    if (amountMinor > (hold.amountMinor ?? 0)) {
      throw new BadRequestException({
        statusCode: 400,
        code: "AMOUNT_EXCEEDS_HOLD",
        message: `No se puede cobrar más de lo retenido (${(hold.amountMinor ?? 0) / 100} ${hold.currency.toUpperCase()}).`,
      });
    }
    const r = await this.captureDamage(
      bookingId,
      amountMinor,
      `manual:${reason}`,
      actorId,
      ctx,
    );
    await this.auditLog.create({
      actorId,
      targetUserId: booking.renterId,
      action: "payment.deposit.captured",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { amountMinor: r.capturedMinor, reason },
    });
    return this.getStatus(actorId, bookingId, { asAdmin: true });
  }

  // ── Cancelación ────────────────────────────────────────────────────────

  /** Lo que pasaría si esta persona cancelara ahora, sin cancelar nada. */
  async previewCancellation(userId: string, bookingId: string) {
    const booking = await this.findBookingForParticipant(userId, bookingId);
    const cancelledBy: CancelledBy =
      userId === booking.ownerId ? "OWNER" : "RENTER";
    const ahora = new Date();
    const decision = decidirCancelacion({
      status: booking.status,
      startDate: booking.startDate,
      ahora,
      laCancelaElDueno: cancelledBy === "OWNER",
    });
    return {
      ...(await this.cancellationOutcome(booking, cancelledBy, ahora, {
        tier: decision.tier === "tardia" ? "tardia" : "libre",
      })),
      puede: decision.puede,
      motivo: decision.motivo,
      tier: decision.tier,
      horasParaElInicio: Math.round(decision.horasParaElInicio),
    };
  }

  private async cancellationOutcome(
    booking: Booking,
    cancelledBy: CancelledBy,
    now: Date,
    opciones: { tier: "libre" | "tardia" },
  ): Promise<CancellationOutcome> {
    const ticket = this.ticketOf(booking);
    return computeCancellation({
      cancelledBy,
      tier: opciones.tier,
      paidMinor: await this.capturedMinor(booking.id),
      rentalMinor: ticket.lines
        .filter((l) => l.code !== "INSURANCE")
        .reduce((t, l) => t + l.amountMinor, 0),
      insuranceMinor:
        ticket.lines.find((l) => l.code === "INSURANCE")?.amountMinor ?? 0,
      senaMinor: ticket.sena.amountMinor,
      commissionPct: this.commissionPct(booking),
      paidAt: booking.paidAt,
      pickupConfirmed: Boolean(booking.pickupConfirmedAt),
      now,
      withdrawalDays: this.withdrawalDays(),
    });
  }

  private withdrawalDays(): number {
    const dias = Number.parseFloat(
      this.config.get<string>("CONSUMER_WITHDRAWAL_DAYS") ?? "",
    );
    return Number.isFinite(dias) && dias >= 0 ? dias : 10;
  }

  /**
   * CANCELA UNA RESERVA PAGA Y REPARTE LA PLATA según la política
   * (money/cancellation-policy.ts). Devuelve el resultado, que queda guardado
   * en la reserva como constancia de qué regla se aplicó.
   *
   * La devolución la hace Mercado Pago sobre el cobro original, y la
   * descuenta EN PROPORCIÓN de la cuenta del dueño y de la de FreeWheel. Lo
   * que esa proporción no reparte como dice la política queda anotado como
   * ajuste con el dueño (ver money/split-refund.ts).
   *
   * Si la devolución falla —el dueño ya retiró la plata de su cuenta y no le
   * alcanza el saldo— esto LANZA y no anota nada: el libro dice lo que pasó,
   * y la cancelación se puede reintentar.
   */
  async cancelAndSettle(
    bookingId: string,
    cancelledBy: CancelledBy,
    /** null cuando lo hace el sistema (el reintento diario), no una persona. */
    actorId: string | null,
    opciones: { tier: "libre" | "tardia"; now?: Date } = { tier: "tardia" },
  ): Promise<CancellationOutcome> {
    const booking = await this.findBookingWithUsers(bookingId);
    await this.assertSinProveedorViejo(bookingId);
    const outcome = await this.cancellationOutcome(
      booking,
      cancelledBy,
      opciones.now ?? new Date(),
      opciones,
    );

    if (outcome.rule !== "UNPAID") {
      await this.ensureFundsJournal(bookingId);
      const checkout = await this.prisma.paymentRecord.findFirst({
        where: {
          bookingId,
          kind: PaymentRecordKind.CHECKOUT,
          status: {
            in: [
              ...PAID_RECORD_STATUSES,
              PaymentRecordStatus.PARTIALLY_REFUNDED,
            ],
          },
        },
      });

      if (outcome.refundToRenterMinor > 0) {
        await this.refundRenter(
          bookingId,
          outcome.refundToRenterMinor,
          actorId,
        );
      }

      if (checkout?.amountMinor) {
        const comision = this.aMinor(booking.platformFeeSnapshot);
        const cobertura = this.aMinor(booking.insuranceSnapshot);
        const reparto = reconcileSplitRefund({
          totalMinor: checkout.amountMinor,
          commissionMinor: comision,
          insuranceMinor: cobertura,
          refundMinor: outcome.refundToRenterMinor,
          expectedCommissionMinor: outcome.platformReceivesMinor,
        });
        await this.ledger.post({
          idempotencyKey: `cancel:${bookingId}`,
          type: `booking.cancelled.${outcome.rule.toLowerCase()}`,
          description: outcome.explanation,
          currency: booking.currency,
          bookingId,
          actorId,
          lines: [
            // Lo que Mercado Pago le descontó a FreeWheel de su cuenta.
            {
              account: Accounts.processorClearing(),
              amountMinor: reparto.platformRefundedMinor,
            },
            // La comisión que corresponde según la política, no la cobrada.
            {
              account: Accounts.platformCommission(),
              amountMinor: outcome.platformReceivesMinor - comision,
            },
            // La cobertura no cubrió nada: deja de deberse a la aseguradora.
            { account: Accounts.insurancePayable(), amountMinor: -cobertura },
            // Lo que el reparto proporcional no le dio al dueño.
            {
              account: Accounts.ownerPayable(booking.ownerId),
              amountMinor: reparto.ownerAdjustmentMinor,
            },
            // Y lo que el dueño devolvió de su propia cuenta.
            {
              account: Accounts.splitOwnerDirect(booking.ownerId),
              amountMinor: -reparto.ownerRefundedMinor,
            },
            {
              account: Accounts.splitCollected(),
              amountMinor: reparto.ownerRefundedMinor,
            },
          ],
        });
      }

      if (outcome.ownerPenaltyMinor > 0) {
        // La seña doblada: el dueño queda debiendo y quien alquiló queda con
        // un crédito. No pasa por la tarjeta porque un reembolso no puede
        // superar el cobro original.
        await this.ledger.post({
          idempotencyKey: `penalty:${bookingId}`,
          type: "owner.cancellation.penalty",
          description:
            "Seña devuelta doblada por cancelación del dueño (CCyC art. 1059)",
          currency: booking.currency,
          bookingId,
          actorId,
          lines: [
            {
              account: Accounts.ownerPayable(booking.ownerId),
              amountMinor: -outcome.ownerPenaltyMinor,
            },
            {
              account: Accounts.renterPayable(booking.renterId),
              amountMinor: outcome.ownerPenaltyMinor,
            },
          ],
        });
      }
    }

    await this.releaseDepositHold(bookingId, actorId);

    const pagado =
      outcome.refundToRenterMinor +
      outcome.ownerReceivesMinor +
      outcome.platformReceivesMinor;
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        cancelledByRole: cancelledBy,
        cancellationSettlement: JSON.parse(
          JSON.stringify(outcome),
        ) as Prisma.InputJsonValue,
        ...(outcome.refundToRenterMinor > 0
          ? {
              paymentStatus:
                outcome.refundToRenterMinor >= pagado
                  ? PaymentStatus.REFUNDED
                  : PaymentStatus.PARTIALLY_REFUNDED,
              refundedAt: new Date(),
            }
          : {}),
        settledAt: new Date(),
      },
    });

    await this.auditLog.create({
      actorId: actorId ?? undefined,
      targetUserId:
        cancelledBy === "OWNER" ? booking.renterId : booking.ownerId,
      action: "payment.cancellation.settled",
      entityType: "Booking",
      entityId: bookingId,
      metadata: {
        rule: outcome.rule,
        refundMinor: outcome.refundToRenterMinor,
        ownerMinor: outcome.ownerReceivesMinor,
        penaltyMinor: outcome.ownerPenaltyMinor,
      },
    });

    await this.payOwner(booking.owner, `cancel:${bookingId}`, actorId);
    return outcome;
  }

  /**
   * LAS CANCELACIONES CUYA DEVOLUCIÓN NO SE PUDO HACER, OTRA VEZ.
   *
   * Una cancelación se registra aunque la devolución falle (ver
   * BookingsService.cancel): la persona pidió cancelar y corresponde. Pero
   * entonces la plata de quien alquiló quedó sin volver, y como la reserva ya
   * está cancelada, nadie la puede volver a cancelar para reintentarlo.
   *
   * Lo corre el trabajo diario. Reaplica la MISMA regla que regía cuando se
   * pidió la cancelación —el tramo y el plazo de arrepentimiento se miden a
   * la hora de la cancelación, no a la de hoy—, y cada paso es idempotente.
   */
  async retryFailedCancellations(now: Date = new Date()): Promise<number> {
    const hace1h = new Date(now.getTime() - 60 * 60 * 1000);
    const trabadas = await this.prisma.booking.findMany({
      where: {
        status: {
          in: [
            BookingStatus.CANCELLED_BY_RENTER,
            BookingStatus.CANCELLED_BY_OWNER,
          ],
        },
        settledAt: null,
        cancelledAt: { lt: hace1h },
        paymentStatus: {
          in: [PaymentStatus.FULLY_PAID, PaymentStatus.PARTIALLY_REFUNDED],
        },
      },
      select: { id: true },
      take: 100,
    });
    let resueltas = 0;
    for (const { id } of trabadas) {
      try {
        await this.retryCancellation(null, id);
        resueltas += 1;
      } catch (error) {
        this.logger.error(
          `la devolución de ${id} sigue sin poder hacerse: ${describirError(error)}`,
        );
      }
    }
    return resueltas;
  }

  /** Reintenta la devolución de una cancelación. También desde el panel. */
  async retryCancellation(actorId: string | null, bookingId: string) {
    const booking = await this.findBooking(bookingId);
    const rol =
      booking.cancelledByRole === "OWNER" ||
      booking.status === BookingStatus.CANCELLED_BY_OWNER
        ? "OWNER"
        : booking.cancelledByRole === "PLATFORM"
          ? "PLATFORM"
          : "RENTER";
    if (!booking.cancelledAt || booking.settledAt) {
      throw new ConflictException({
        statusCode: 409,
        code: "NOTHING_TO_RETRY",
        message:
          "Esta reserva no tiene una cancelación con la plata pendiente.",
      });
    }
    // El tramo se mide al momento de la cancelación, con el estado que la
    // reserva tenía antes de cancelarse.
    const decision = decidirCancelacion({
      status: BookingStatus.ACCEPTED,
      startDate: booking.startDate,
      ahora: booking.cancelledAt,
      laCancelaElDueno: rol === "OWNER",
    });
    return this.cancelAndSettle(bookingId, rol, actorId, {
      tier: decision.tier === "tardia" ? "tardia" : "libre",
      now: booking.cancelledAt,
    });
  }

  /** Mantiene el nombre viejo: cancelar con la política completa. */
  async refundOnCancel(actorId: string, bookingId: string) {
    const booking = await this.findBooking(bookingId);
    const cancelledBy: CancelledBy =
      actorId === booking.ownerId
        ? "OWNER"
        : actorId === booking.renterId
          ? "RENTER"
          : "PLATFORM";
    return this.cancelAndSettle(bookingId, cancelledBy, actorId);
  }

  /** Devuelve a la tarjeta de quien alquiló, sobre el cobro de la reserva. */
  private async refundRenter(
    bookingId: string,
    amountMinor: number,
    actorId: string | null,
  ) {
    const booking = await this.findBookingWithUsers(bookingId);
    const record = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.CHECKOUT,
        status: {
          in: [...PAID_RECORD_STATUSES, PaymentRecordStatus.PARTIALLY_REFUNDED],
        },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!record?.providerPaymentId) {
      throw new ConflictException({
        statusCode: 409,
        code: "NOTHING_TO_REFUND",
        message: "La reserva no tiene un cobro sobre el cual devolver.",
      });
    }
    const disponible =
      (record.amountMinor ?? 0) - (record.refundedAmountMinor ?? 0);
    const monto = Math.min(disponible, amountMinor);
    if (monto <= 0) return;

    const refund = await this.provider.refundPayment(
      await this.collectorFor(booking.owner, record),
      record.providerPaymentId,
      monto >= (record.amountMinor ?? 0) ? null : monto,
      `fw_refund_${record.id}_${monto}`,
    );
    const devuelto = (record.refundedAmountMinor ?? 0) + monto;
    await this.prisma.$transaction([
      this.prisma.paymentRecord.update({
        where: { id: record.id },
        data: {
          status:
            devuelto >= (record.amountMinor ?? 0)
              ? PaymentRecordStatus.REFUNDED
              : PaymentRecordStatus.PARTIALLY_REFUNDED,
          refundedAmountMinor: devuelto,
          refundedAt: new Date(),
        },
      }),
      this.prisma.paymentRecord.create({
        data: {
          bookingId,
          userId: record.userId,
          kind: PaymentRecordKind.REFUND,
          status: PaymentRecordStatus.REFUNDED,
          provider: this.provider.name,
          providerId: refund.id,
          providerRefundId: refund.id,
          collectorId: record.collectorId,
          amount: monto / 100,
          amountMinor: monto,
          currency: record.currency,
          refundedAt: new Date(),
        },
      }),
    ]);
    await this.recordEvent({
      record,
      bookingId,
      actorId,
      source: "api",
      type: "refund.created",
      status: PaymentRecordStatus.REFUNDED,
      amountMinor: monto,
      currency: record.currency,
    });
  }

  // ── Operaciones de administración sobre el libro ──────────────────────

  /** Los saldos de todos los bolsillos, o de los que empiezan con un prefijo. */
  ledgerBalances(prefix?: string) {
    return this.ledger.balances({ prefix });
  }

  ledgerForBooking(bookingId: string) {
    return this.ledger.journalsForBooking(bookingId);
  }

  /**
   * Registra que se le pagó a la aseguradora lo cobrado por su cuenta. Es la
   * forma legal de "vaciar" la cobertura: pagándole a quien corresponde, no
   * pasándola a una cuenta de FreeWheel.
   */
  async recordInsuranceRemittance(
    actorId: string,
    amountMinor: number,
    currency: string,
    reference: string,
  ) {
    const debido = await this.ledger.balance(Accounts.insurancePayable());
    if (amountMinor <= 0 || amountMinor > debido) {
      throw new BadRequestException({
        statusCode: 400,
        code: "INVALID_AMOUNT",
        message: `El monto tiene que estar entre 1 y lo debido a la aseguradora (${debido}).`,
      });
    }
    await this.ledger.post({
      idempotencyKey: `insurance-remittance:${reference}`,
      type: "insurance.remitted",
      description: `Pago a la aseguradora (${reference})`,
      currency,
      actorId,
      lines: [
        { account: Accounts.insurancePayable(), amountMinor: -amountMinor },
        { account: Accounts.processorClearing(), amountMinor },
      ],
    });
    await this.auditLog.create({
      actorId,
      action: "ledger.insurance.remitted",
      entityType: "Ledger",
      entityId: reference,
      metadata: { amountMinor, currency },
    });
    return { remainingMinor: debido - amountMinor };
  }

  /**
   * Registra que se le pagó a quien alquiló un crédito que no podía ir a su
   * tarjeta (la seña doblada de una cancelación del dueño).
   */
  async recordRenterCompensationPaid(
    actorId: string,
    renterId: string,
    amountMinor: number,
    currency: string,
    reference: string,
  ) {
    const debido = await this.ledger.balance(Accounts.renterPayable(renterId));
    if (amountMinor <= 0 || amountMinor > debido) {
      throw new BadRequestException({
        statusCode: 400,
        code: "INVALID_AMOUNT",
        message: `El monto tiene que estar entre 1 y lo que se le debe (${debido}).`,
      });
    }
    await this.ledger.post({
      idempotencyKey: `renter-compensation:${reference}`,
      type: "renter.compensation.paid",
      description: `Pago a quien alquiló (${reference})`,
      currency,
      actorId,
      lines: [
        {
          account: Accounts.renterPayable(renterId),
          amountMinor: -amountMinor,
        },
        { account: Accounts.processorClearing(), amountMinor },
      ],
    });
    await this.auditLog.create({
      actorId,
      targetUserId: renterId,
      action: "ledger.renter.compensation_paid",
      entityType: "Ledger",
      entityId: reference,
      metadata: { amountMinor, currency },
    });
    return { remainingMinor: debido - amountMinor };
  }

  /**
   * Registra que se le pagó a un dueño, por transferencia, un saldo que el
   * split no le podía dar (el ajuste de una cancelación con seña).
   */
  async recordOwnerPayoutPaid(
    actorId: string,
    ownerId: string,
    amountMinor: number,
    currency: string,
    reference: string,
  ) {
    const debido = await this.ledger.balance(Accounts.ownerPayable(ownerId));
    if (amountMinor <= 0 || amountMinor > debido) {
      throw new BadRequestException({
        statusCode: 400,
        code: "INVALID_AMOUNT",
        message: `El monto tiene que estar entre 1 y lo que se le debe (${debido}).`,
      });
    }
    await this.ledger.post({
      idempotencyKey: `owner-payout:${reference}`,
      type: "owner.payout.manual",
      description: `Transferencia al dueño por fuera del split (${reference})`,
      currency,
      actorId,
      lines: [
        { account: Accounts.ownerPayable(ownerId), amountMinor: -amountMinor },
        { account: Accounts.processorClearing(), amountMinor },
      ],
    });
    await this.auditLog.create({
      actorId,
      targetUserId: ownerId,
      action: "ledger.owner.payout_paid",
      entityType: "Ledger",
      entityId: reference,
      metadata: { amountMinor, currency },
    });
    return { remainingMinor: debido - amountMinor };
  }

  // ── La cuenta de Mercado Pago del dueño ────────────────────────────────

  /**
   * EMPIEZA LA VINCULACIÓN: devuelve la URL de Mercado Pago a la que hay que
   * mandar al dueño.
   *
   * El `state` es lo único que identifica a la persona cuando Mercado Pago la
   * devuelve (esa vuelta llega sin la sesión de FreeWheel). Por eso va
   * CIFRADO y con vencimiento: nadie puede fabricar uno que vincule SU cuenta
   * de Mercado Pago al usuario de otra persona, y uno viejo no sirve.
   *
   * Lleva adentro el verificador de PKCE, que es lo que impide que alguien
   * que intercepte el código de la vuelta lo pueda canjear.
   */
  createOwnerOnboarding(ownerId: string) {
    const verificador = base64url(randomBytes(32));
    const desafio = base64url(
      createHash("sha256").update(verificador).digest(),
    );
    const state = base64url(
      Buffer.from(
        this.encryption.encrypt(
          JSON.stringify({
            u: ownerId,
            n: base64url(randomBytes(12)),
            e: Date.now() + VIGENCIA_DEL_STATE_MS,
            v: verificador,
          }),
        ),
        "utf8",
      ),
    );
    const onboardingUrl = this.provider.authorizationUrl({
      state,
      redirectUri: this.oauthRedirectUri(),
      codeChallenge: desafio,
    });
    return { provider: this.provider.name, onboardingUrl };
  }

  /**
   * TERMINA LA VINCULACIÓN: Mercado Pago devuelve al dueño con un código, se
   * canjea por sus credenciales y se guardan cifradas.
   *
   * Devuelve la URL del front a la que redirigir, con el resultado: esta
   * vuelta la hace el navegador, así que un error no puede ser un JSON.
   */
  async completeOwnerOnboarding(input: {
    code?: string | null;
    state?: string | null;
    error?: string | null;
  }): Promise<string> {
    const volver = (status: string, code?: string) => {
      const url = new URL(this.oauthReturnUrl());
      url.searchParams.set("status", status);
      if (code) url.searchParams.set("code", code);
      return url.toString();
    };

    if (input.error) return volver("error", "MP_AUTHORIZATION_DENIED");
    if (!input.code || !input.state) return volver("error", "MP_MISSING_CODE");

    let datos: { u: string; e: number; v: string };
    try {
      const crudo = Buffer.from(input.state, "base64url").toString("utf8");
      datos = JSON.parse(this.encryption.decrypt(crudo)) as typeof datos;
    } catch {
      return volver("error", "MP_INVALID_STATE");
    }
    if (!datos.u || !datos.e || datos.e < Date.now()) {
      return volver("error", "MP_STATE_EXPIRED");
    }

    const owner = await this.prisma.user.findUnique({ where: { id: datos.u } });
    if (!owner) return volver("error", "MP_INVALID_STATE");

    let credenciales;
    try {
      credenciales = await this.provider.exchangeAuthorizationCode({
        code: input.code,
        redirectUri: this.oauthRedirectUri(),
        codeVerifier: datos.v,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `no se pudo canjear el código de ${owner.id}: ${message}`,
      );
      return volver("error", "MP_EXCHANGE_FAILED");
    }

    // Una misma cuenta de Mercado Pago no puede cobrar para dos usuarios de
    // FreeWheel: los cobros de uno terminarían en la cuenta del otro.
    const otro = await this.prisma.user.findUnique({
      where: { mpUserId: credenciales.userId },
      select: { id: true },
    });
    if (otro && otro.id !== owner.id) {
      return volver("error", "MP_ACCOUNT_ALREADY_LINKED");
    }

    await this.guardarCredenciales(owner.id, credenciales);
    await this.auditLog.create({
      actorId: owner.id,
      targetUserId: owner.id,
      action: "payments.owner.linked",
      entityType: "User",
      entityId: owner.id,
      metadata: {
        mpUserId: credenciales.userId,
        liveMode: credenciales.liveMode,
      },
    });
    return volver("ok");
  }

  /** El estado de cobro del dueño. */
  async getOwnerPayoutStatus(ownerId: string) {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: {
        mpUserId: true,
        mpAccessTokenEnc: true,
        mpLinkedAt: true,
        mpTokenExpiresAt: true,
        mpLiveMode: true,
      },
    });
    assertFound(owner, "User not found");
    const connected = Boolean(owner.mpUserId && owner.mpAccessTokenEnc);
    return {
      provider: this.provider.name,
      connected,
      linkedAt: owner.mpLinkedAt,
      expiresAt: owner.mpTokenExpiresAt,
      liveMode: owner.mpLiveMode,
      // Una cuenta de prueba vinculada a un deploy de producción (o al revés)
      // no puede cobrar: se avisa antes de que alguien lo descubra pagando.
      modeMatches:
        !connected || owner.mpLiveMode == null
          ? true
          : owner.mpLiveMode === this.provider.liveMode,
    };
  }

  /**
   * DESVINCULAR: borra las credenciales del dueño.
   *
   * No se puede con cobros vivos. Sin el token no se puede devolver, capturar
   * ni soltar nada en su cuenta, así que una reserva paga o con depósito
   * autorizado quedaría sin forma de resolverse desde acá.
   */
  async unlinkOwner(ownerId: string) {
    const owner = await this.prisma.user.findUnique({ where: { id: ownerId } });
    assertFound(owner, "User not found");
    if (!owner.mpUserId) return { connected: false };

    const vivos = await this.prisma.booking.count({
      where: {
        ownerId,
        settledAt: null,
        paymentStatus: {
          in: [
            PaymentStatus.FULLY_PAID,
            PaymentStatus.PARTIALLY_REFUNDED,
            PaymentStatus.DISPUTED,
          ],
        },
      },
    });
    if (vivos > 0) {
      throw new ConflictException({
        statusCode: 409,
        code: "OWNER_HAS_ACTIVE_PAYMENTS",
        message:
          `Tenés ${vivos} reserva(s) con pagos sin cerrar. Se puede ` +
          "desvincular Mercado Pago cuando terminen.",
      });
    }
    await this.prisma.user.update({
      where: { id: ownerId },
      data: {
        mpUserId: null,
        mpAccessTokenEnc: null,
        mpRefreshTokenEnc: null,
        mpPublicKey: null,
        mpTokenExpiresAt: null,
        mpLinkedAt: null,
        mpLiveMode: null,
      },
    });
    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: ownerId,
      action: "payments.owner.unlinked",
      entityType: "User",
      entityId: ownerId,
    });
    return { connected: false };
  }

  /** Si el dueño puede cobrar. Lo usa la aceptación de una reserva. */
  async assertOwnerCanCollect(ownerId: string): Promise<void> {
    const owner = await this.prisma.user.findUnique({ where: { id: ownerId } });
    assertFound(owner, "User not found");
    if (!owner.mpUserId || !owner.mpAccessTokenEnc) throw this.ownerNotLinked();
  }

  /**
   * LAS CREDENCIALES DEL DUEÑO, LISTAS PARA OPERAR.
   *
   * Se descifran acá y viajan solo al provider. Si el token está por vencer
   * se renueva antes de usarlo: un token de 180 días vence justo el día que
   * hay que devolverle la plata a alguien.
   *
   * Con `record`, además se controla que la cuenta vinculada HOY sea la que
   * cobró ESE pago: un dueño que cambió de cuenta de Mercado Pago no puede
   * operar pagos de la cuenta anterior con el token de la nueva.
   */
  private async collectorFor(
    owner: User,
    record?: PaymentRecord | null,
  ): Promise<CollectorCredentials> {
    if (!owner.mpUserId || !owner.mpAccessTokenEnc) throw this.ownerNotLinked();
    if (record?.collectorId && record.collectorId !== owner.mpUserId) {
      throw new ConflictException({
        statusCode: 409,
        code: "COLLECTOR_ACCOUNT_CHANGED",
        message:
          "Este cobro se hizo en otra cuenta de Mercado Pago del dueño. Hay " +
          "que resolverlo desde el panel de Mercado Pago de esa cuenta.",
      });
    }

    let accessToken = this.encryption.decrypt(owner.mpAccessTokenEnc);
    const vence = owner.mpTokenExpiresAt?.getTime() ?? 0;
    if (owner.mpRefreshTokenEnc && vence - Date.now() < RENOVAR_ANTES_DE_MS) {
      try {
        const nuevas = await this.provider.refreshCredentials(
          this.encryption.decrypt(owner.mpRefreshTokenEnc),
        );
        await this.guardarCredenciales(owner.id, nuevas);
        accessToken = nuevas.accessToken;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (vence < Date.now()) {
          this.logger.error(
            `el token del dueño ${owner.id} venció y no se pudo renovar: ${message}`,
          );
          throw new ConflictException({
            statusCode: 409,
            code: "OWNER_PAYMENTS_RELINK_REQUIRED",
            message:
              "La cuenta de Mercado Pago del dueño necesita volver a " +
              "vincularse para poder cobrar.",
          });
        }
        this.logger.warn(
          `no se pudo renovar el token del dueño ${owner.id}: ${message}`,
        );
      }
    }
    return { userId: owner.mpUserId, accessToken };
  }

  private async guardarCredenciales(
    ownerId: string,
    credenciales: {
      userId: string;
      accessToken: string;
      refreshToken: string;
      publicKey: string;
      expiresAt: Date;
      liveMode: boolean;
    },
  ) {
    await this.prisma.user.update({
      where: { id: ownerId },
      data: {
        mpUserId: credenciales.userId,
        mpAccessTokenEnc: this.encryption.encrypt(credenciales.accessToken),
        mpRefreshTokenEnc: credenciales.refreshToken
          ? this.encryption.encrypt(credenciales.refreshToken)
          : null,
        mpPublicKey: credenciales.publicKey || null,
        mpTokenExpiresAt: credenciales.expiresAt,
        mpLinkedAt: new Date(),
        mpLiveMode: credenciales.liveMode,
      },
    });
  }

  private ownerNotLinked(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: "OWNER_PAYMENTS_NOT_LINKED",
      message:
        "El dueño todavía no vinculó su cuenta de Mercado Pago, así que no " +
        "puede cobrar. Se vincula desde su perfil (POST /payments/connect/onboarding).",
    });
  }

  private oauthRedirectUri(): string {
    return (
      this.config.get<string>("MP_OAUTH_REDIRECT_URI")?.trim() ||
      `${getPublicApiBaseUrl(this.config)}/payments/mercadopago/oauth/callback`
    );
  }

  private oauthReturnUrl(): string {
    return (
      this.config.get<string>("MP_OAUTH_RETURN_URL")?.trim() ||
      `${getFrontendUrl(this.config)}/mercadopago/vinculacion`
    );
  }

  /**
   * A dónde manda Mercado Pago los avisos de cada cobro. Solo si hay una URL
   * pública estable: la URL propia de cada deploy de Vercel cambia en cada
   * deploy y puede estar protegida, así que un aviso mandado ahí se pierde.
   * Sin una URL estable, los avisos llegan por los webhooks configurados en
   * la aplicación de Mercado Pago, que es el camino principal igual.
   */
  private notificationUrl(): string | null {
    const explicita = this.config.get<string>("MP_NOTIFICATION_URL")?.trim();
    if (explicita) return explicita;
    if (this.config.get<string>("API_BASE_URL")) {
      return `${getPublicApiBaseUrl(this.config)}/payments/mercadopago/webhook`;
    }
    return null;
  }

  // ── Registro append-only ───────────────────────────────────────────────

  /**
   * Anota una línea en el registro de lo que le pasó a un cobro.
   *
   * NUNCA HACE FALLAR LA OPERACIÓN QUE LA MOTIVÓ: revertir un cobro que ya se
   * hizo porque no se pudo escribir una línea de auditoría sería cambiar un
   * problema de trazabilidad por uno de plata.
   */
  private async recordEvent(input: {
    record?: PaymentRecord | null;
    bookingId?: string | null;
    actorId?: string | null;
    source: "api" | "webhook" | "system";
    type: string;
    status?: PaymentRecordStatus;
    amountMinor?: number | null;
    currency?: string | null;
    providerEventId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    payload?: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      await this.prisma.paymentEvent.create({
        data: {
          paymentRecordId: input.record?.id ?? null,
          bookingId: input.bookingId ?? input.record?.bookingId ?? null,
          actorId: input.actorId ?? null,
          source: input.source,
          type: input.type,
          status: input.status ?? null,
          amountMinor: input.amountMinor ?? null,
          currency: input.currency ?? null,
          providerEventId: input.providerEventId
            ? `${input.providerEventId}:${input.type}`
            : null,
          ip: input.ip ?? null,
          userAgent: input.userAgent?.slice(0, 500) ?? null,
          payload: (input.payload ?? undefined) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `no se pudo anotar el evento ${input.type} del cobro ` +
          `${input.record?.id ?? "(sin registro)"}: ${message}`,
      );
    }
  }

  /**
   * El historial completo de una reserva: cada línea, en orden. Va SIN la IP
   * ni el navegador para quien no es administrador.
   */
  async getLedger(userId: string, bookingId: string, isAdmin: boolean) {
    await this.findBookingForParticipant(userId, bookingId);
    const events = await this.prisma.paymentEvent.findMany({
      where: { bookingId },
      orderBy: { createdAt: "asc" },
    });
    return events.map((event) => ({
      id: event.id,
      type: event.type,
      status: event.status,
      amountMinor: event.amountMinor,
      currency: event.currency,
      source: event.source,
      createdAt: event.createdAt,
      ...(isAdmin
        ? { ip: event.ip, userAgent: event.userAgent, payload: event.payload }
        : {}),
    }));
  }

  // ── Mails ──────────────────────────────────────────────────────────────

  /** Cómo se llama cada cobro para una persona, no para el código. */
  private static readonly CONCEPTO: Record<string, string> = {
    CHECKOUT: "Pago de la reserva",
    SENA: "Seña",
    BALANCE: "Saldo",
    DEPOSIT_HOLD: "Depósito en garantía",
    DEPOSIT_CAPTURE: "Cobro del depósito en garantía",
  };

  /**
   * Comprobante al inquilino y aviso al dueño, cada vez que un cobro se
   * concreta. Nunca hace fallar el pago: si el mail no sale, queda en el log.
   */
  private async avisarDelPago(
    bookingId: string,
    kind: PaymentRecordKind | null,
    amount: number | null,
  ): Promise<void> {
    if (!kind || amount == null) return;
    try {
      const booking = await this.prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          owner: { select: USER_CONTACT_SELECT },
          renter: { select: USER_CONTACT_SELECT },
          vehicle: { select: { brand: true, model: true, year: true } },
        },
      });
      if (!booking) return;

      const concepto = PaymentsService.CONCEPTO[kind] ?? "Pago";
      const vehicleLabel = this.vehicleLabel(booking);
      const nombre = (persona?: {
        displayName?: string | null;
        firstName?: string | null;
        lastName?: string | null;
      }) =>
        persona?.displayName ??
        [persona?.firstName, persona?.lastName]
          .filter(Boolean)
          .join(" ")
          .trim();

      if (booking.renter?.email) {
        await this.email.sendPaymentReceipt(booking.renter.email, {
          renterName: nombre(booking.renter),
          concepto,
          amount,
          currency: booking.currency,
          vehicleLabel,
          startDate: booking.startDate,
          endDate: booking.endDate,
          totalPaid: amount,
          bookingId: booking.id,
        });
      }

      if (booking.owner?.email && kind !== PaymentRecordKind.DEPOSIT_HOLD) {
        await this.email.sendPaymentReceivedToOwner(booking.owner.email, {
          ownerName: nombre(booking.owner),
          renterName: nombre(booking.renter) || "El inquilino",
          concepto,
          amount,
          currency: booking.currency,
          vehicleLabel,
          startDate: booking.startDate,
          endDate: booking.endDate,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `No se pudo avisar del pago de ${bookingId}: ${message}`,
      );
    }
  }

  /**
   * EL MAIL DE "SE LIBERÓ TU DEPÓSITO". Hace falta porque liberar una reserva
   * de fondos no genera ningún movimiento en el resumen: sin un mail, la
   * única señal es que el disponible deja de estar recortado.
   */
  private async avisarDeLaLiberacion(
    bookingId: string,
    hold: PaymentRecord,
  ): Promise<void> {
    try {
      const booking = await this.findBookingWithUsers(bookingId);
      if (!booking.renter?.email) return;
      await this.email.sendDepositReleased(booking.renter.email, {
        renterName:
          booking.renter.displayName ??
          `${booking.renter.firstName} ${booking.renter.lastName}`,
        amount: (hold.amountMinor ?? 0) / 100,
        currency: hold.currency ?? booking.currency,
        vehicleLabel: this.vehicleLabel(booking),
        cardBrand: hold.cardBrand,
        cardLast4: hold.cardLast4,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `No se pudo avisar de la liberación del depósito de ${bookingId}: ${message}`,
      );
    }
  }

  /** Los mails de "se cobró parte del depósito", a las dos partes. */
  private async avisarDeLaCaptura(
    bookingId: string,
    capturadoMinor: number,
    retenidoMinor: number,
    motivo: string,
  ): Promise<void> {
    try {
      const booking = await this.findBookingWithUsers(bookingId);
      const liberadoMinor = Math.max(0, retenidoMinor - capturadoMinor);
      const nombre = (persona?: {
        displayName?: string | null;
        firstName?: string | null;
        lastName?: string | null;
      }) =>
        persona?.displayName ||
        [persona?.firstName, persona?.lastName].filter(Boolean).join(" ") ||
        "";

      for (const parte of [
        { datos: booking.renter, otra: booking.owner, esDueño: false },
        { datos: booking.owner, otra: booking.renter, esDueño: true },
      ]) {
        if (!parte.datos?.email) continue;
        await this.email.sendDepositCaptured(parte.datos.email, {
          recipientName: nombre(parte.datos),
          esDueño: parte.esDueño,
          otherPartyName: nombre(parte.otra),
          capturado: capturadoMinor / 100,
          liberado: liberadoMinor / 100,
          currency: booking.currency,
          vehicleLabel: this.vehicleLabel(booking),
          motivo,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `No se pudo avisar de la captura del depósito de ${bookingId}: ${message}`,
      );
    }
  }

  // ── Ayudantes ──────────────────────────────────────────────────────────

  private amountForKind(booking: Booking, kind: PaymentRecordKindLike): number {
    const total =
      booking.rentalSubtotalSnapshot != null &&
      booking.insuranceSnapshot != null
        ? booking.rentalSubtotalSnapshot + booking.insuranceSnapshot
        : null;
    const map: Record<PaymentRecordKindLike, number | null> = {
      CHECKOUT: total,
      SENA: booking.senaAmountSnapshot,
      BALANCE: booking.balanceAmountSnapshot,
      DEPOSIT_HOLD: booking.depositSnapshot,
    };
    const value = map[kind];
    if (value == null) {
      throw new BadRequestException(
        "Booking is missing pricing snapshots; accept it first",
      );
    }
    const minor = Math.round(value * 100);
    if (!Number.isFinite(minor) || minor <= 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: "INVALID_AMOUNT",
        message: "El importe de este cobro no es válido",
      });
    }
    return minor;
  }

  /** Lo cobrado de verdad en una reserva, neto de devoluciones. */
  private async capturedMinor(
    bookingId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    const cobros = await db.paymentRecord.findMany({
      where: {
        bookingId,
        kind: {
          in: [
            PaymentRecordKind.CHECKOUT,
            PaymentRecordKind.SENA,
            PaymentRecordKind.BALANCE,
          ],
        },
        status: {
          in: [
            ...PAID_RECORD_STATUSES,
            PaymentRecordStatus.PARTIALLY_REFUNDED,
            PaymentRecordStatus.DISPUTED,
          ],
        },
      },
      select: { amountMinor: true, refundedAmountMinor: true },
    });
    return cobros.reduce(
      (total, r) => total + (r.amountMinor ?? 0) - (r.refundedAmountMinor ?? 0),
      0,
    );
  }

  /** Un importe congelado de la reserva, en unidades mínimas. */
  private aMinor(valor: number | null | undefined): number {
    return valor == null ? 0 : Math.round(valor * 100);
  }

  /**
   * Mercado Pago Argentina cobra en pesos. Una reserva congelada en otra
   * moneda (las que se aceptaron cuando el procesador era Stripe, en dólares)
   * no se puede cobrar por acá: se dice claro en vez de mandar a Mercado Pago
   * un importe que interpretaría como pesos.
   */
  private assertCurrency(booking: Booking): void {
    if (booking.currency.toUpperCase() !== "ARS") {
      throw new ConflictException({
        statusCode: 409,
        code: "CURRENCY_NOT_SUPPORTED",
        message:
          `Esta reserva está en ${booking.currency.toUpperCase()} y Mercado ` +
          "Pago cobra en pesos. Hay que volver a pedirla para que se congele " +
          "en ARS (y revisar DEFAULT_CURRENCY en el servidor).",
      });
    }
  }

  /**
   * Una reserva con cobros del procesador anterior (Stripe) no se puede
   * operar con Mercado Pago: esos cobros viven en otra cuenta y otra API.
   * Eran todos de prueba; se resuelven desde la rama `pagos-stripe`.
   */
  private async assertSinProveedorViejo(bookingId: string): Promise<void> {
    const viejo = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        provider: { notIn: [this.provider.name, "unconfigured"] },
        status: {
          notIn: [PaymentRecordStatus.FAILED, PaymentRecordStatus.CANCELLED],
        },
      },
      select: { provider: true },
    });
    if (viejo) {
      throw new ConflictException({
        statusCode: 409,
        code: "LEGACY_PROVIDER_BOOKING",
        message:
          `Esta reserva tiene cobros de ${viejo.provider}, el procesador ` +
          "anterior, y no se puede operar con Mercado Pago.",
      });
    }
  }

  private descripcion(booking: Booking & { vehicle?: unknown }): string {
    const desde = booking.startDate.toISOString().slice(0, 10);
    const hasta = booking.endDate.toISOString().slice(0, 10);
    return `FreeWheel — reserva del ${desde} al ${hasta}`;
  }

  /** "Toyota Corolla 2020", para nombrar el auto en un mail. */
  private vehicleLabel(booking: {
    vehicle?: {
      brand?: string | null;
      model?: string | null;
      year?: number | null;
    } | null;
  }): string {
    return (
      [booking.vehicle?.brand, booking.vehicle?.model, booking.vehicle?.year]
        .filter(Boolean)
        .join(" ") || "el vehículo"
    );
  }

  private async findBooking(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    assertFound(booking, "Booking not found");
    return booking;
  }

  private async findBookingWithUsers(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { owner: true, renter: true, vehicle: true },
    });
    assertFound(booking, "Booking not found");
    return booking;
  }

  private async findBookingForParticipant(userId: string, bookingId: string) {
    const booking = await this.findBooking(bookingId);
    assertParticipant(
      booking.ownerId,
      booking.renterId,
      userId,
      "You cannot access this payment",
    );
    return booking;
  }
}

type BookingWithUsers = Prisma.BookingGetPayload<{
  include: { owner: true; renter: true; vehicle: true };
}>;

/**
 * Un error, en una línea que sirva para el log: con el código de negocio si
 * es una excepción HTTP (el mensaje solo no alcanza para buscarlo).
 */
function describirError(error: unknown): string {
  if (error && typeof error === "object" && "getResponse" in error) {
    const cuerpo = (error as { getResponse: () => unknown }).getResponse();
    if (cuerpo && typeof cuerpo === "object") {
      const { code, message } = cuerpo as { code?: unknown; message?: unknown };
      const texto = (v: unknown) =>
        typeof v === "string" || typeof v === "number" ? String(v) : "";
      return `${texto(code) || "HTTP"}: ${texto(message)}`;
    }
  }
  if (error instanceof Error) {
    // Los errores de Prisma traen varias líneas y la primera está vacía: la
    // que dice qué pasó es la última.
    const lineas = error.message
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return lineas.at(-1) ?? error.name;
  }
  return String(error);
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/** Las columnas de tarjeta y riesgo, solo cuando hay algo que escribir. */
function cardColumns(detalle: PaymentResult | null) {
  if (!detalle) return {};
  return {
    ...(detalle.card
      ? {
          cardBrand: detalle.card.brand,
          cardLast4: detalle.card.last4,
          cardFingerprint: detalle.card.fingerprint,
          cardCountry: detalle.card.country,
        }
      : {}),
    ...(detalle.risk
      ? { riskLevel: detalle.risk.level, riskScore: detalle.risk.score }
      : {}),
  };
}

/**
 * UN COBRO, COMO LO VE QUIEN PARTICIPA DE LA RESERVA.
 *
 * La fila completa NO se devuelve: guarda la huella de la tarjeta, la IP y el
 * navegador de quien pagó, y devolverla entera le mostraría al dueño del auto
 * desde dónde se conecta quien se lo alquiló. Eso es vigilancia.
 */
function publicRecord(record: PaymentRecord) {
  return {
    id: record.id,
    bookingId: record.bookingId,
    kind: record.kind,
    status: record.status,
    amount: record.amount,
    amountMinor: record.amountMinor,
    refundedAmountMinor: record.refundedAmountMinor,
    currency: record.currency,
    cardBrand: record.cardBrand,
    cardLast4: record.cardLast4,
    failureCode: record.failureCode,
    failureMessage: record.failureMessage,
    paidAt: record.paidAt,
    capturedAt: record.capturedAt,
    releasedAt: record.releasedAt,
    refundedAt: record.refundedAt,
    disputedAt: record.disputedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
