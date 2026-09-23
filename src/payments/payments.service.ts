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
  StripeAccountStatus,
  User,
} from "@prisma/client";
import { AuditLogService } from "../common/services/audit-log.service";
import { USER_CONTACT_SELECT } from "../common/constants/prisma-select";
import { EmailService } from "../email/email.service";
import { assertFound } from "../common/utils/entity.util";
import { assertParticipant } from "../common/utils/authorization.util";
import { PrismaService } from "../prisma/prisma.service";
import { ContractsService } from "../contracts/contracts.service";
import { LedgerService } from "../ledger/ledger.service";
import { Accounts } from "../ledger/accounts";
import { decidirCancelacion } from "../bookings/cancellation-policy";
import { buildTicket, Ticket } from "./money/ticket";
import {
  CancellationOutcome,
  CancelledBy,
  computeCancellation,
} from "./money/cancellation-policy";
import { PAYMENT_PROVIDER } from "./providers/payment-provider.interface";
import type {
  PaymentIntentResult,
  PaymentProvider,
  PaymentRecordKindLike,
  SavedCard,
} from "./providers/payment-provider.interface";

/** Estados en los que la plata efectivamente entró. */
const PAID_RECORD_STATUSES: PaymentRecordStatus[] = [
  PaymentRecordStatus.PAID,
  PaymentRecordStatus.CAPTURED,
];

/**
 * Estados de un intent que NO se pueden reutilizar: hay que crear uno nuevo.
 *
 * Un intent fallado o cancelado no se puede volver a confirmar del lado de
 * Stripe, así que devolverle al front su client secret sería mandarlo a
 * intentar contra algo muerto.
 */
const UNUSABLE_RECORD_STATUSES: PaymentRecordStatus[] = [
  PaymentRecordStatus.FAILED,
  PaymentRecordStatus.CANCELLED,
];

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
  ) {}

  // ── El cobro único (lo pide quien alquila) ─────────────────────────────

  /**
   * EL PAGO DE UNA RESERVA: alquiler + cobertura, de una sola vez.
   *
   * Reemplaza al par seña + saldo. La seña no desapareció: es la porción del
   * alquiler que queda sujeta a la regla penitencial si alguien se arrepiente
   * (ver money/cancellation-policy.ts), y el ticket la muestra. Lo que
   * desapareció es el segundo cobro, que obligaba a la persona a volver a
   * pagar días después y dejaba reservas a medio pagar el día del retiro.
   *
   * Dos condiciones antes de cobrar, y las dos son legales antes que técnicas:
   *   · quien alquila ACEPTÓ el contrato vigente. Nadie paga bajo condiciones
   *     que no aceptó, y el cobro es el momento en que las condiciones pasan a
   *     obligar.
   *   · el importe sale de los precios congelados de la reserva, nunca del
   *     cliente.
   *
   * La tarjeta queda guardada (setup_future_usage) para autorizar el depósito
   * en garantía cerca del retiro sin volver a pedírsela a nadie.
   */
  async createCheckout(
    renterId: string,
    bookingId: string,
    ctx: PaymentContext,
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

    const totalMinor = this.amountForKind(booking, "CHECKOUT");
    // Una reserva vieja que llegó a pagar la seña con el flujo anterior paga
    // acá solo lo que le falta. Las nuevas pagan el total.
    const yaCobrado = await this.capturedMinor(bookingId);
    const amountMinor = totalMinor - yaCobrado;
    if (amountMinor <= 0) {
      throw new ConflictException({
        statusCode: 409,
        code: "ALREADY_PAID",
        message: "Esta reserva ya está paga.",
      });
    }

    return this.createOrReuseIntent(booking, "CHECKOUT", amountMinor, ctx, {
      // "off_session" porque con esta misma tarjeta se autoriza después el
      // depósito en garantía, solo, al marcar el auto listo para entregar.
      setupFutureUsage: "off_session",
      // Y que además quede en la lista de tarjetas guardadas, para que la
      // próxima reserva no obligue a escribirla de nuevo.
      saveCard: true,
    });
  }

  /**
   * DEPRECADO: la seña ya no se cobra aparte. Se mantiene como alias del cobro
   * único para que el front publicado no se rompa: la primera llamada que
   * hacía ahora cobra todo.
   */
  createSenaIntent(renterId: string, bookingId: string, ctx: PaymentContext) {
    return this.createCheckout(renterId, bookingId, ctx);
  }

  /**
   * DEPRECADO: ya no hay saldo aparte. Solo sigue existiendo para una reserva
   * vieja que pagó la seña con el flujo anterior: esa sí tiene un saldo
   * pendiente, y se cobra por el camino nuevo.
   */
  async createBalanceIntent(
    renterId: string,
    bookingId: string,
    ctx: PaymentContext,
  ) {
    const senaVieja = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.SENA,
        status: { in: PAID_RECORD_STATUSES },
      },
      select: { id: true },
    });
    if (!senaVieja) {
      throw new ConflictException({
        statusCode: 409,
        code: "PAYMENT_IS_SINGLE",
        message:
          "El pago de una reserva es uno solo: usá POST " +
          "/payments/bookings/:bookingId/checkout.",
      });
    }
    return this.createCheckout(renterId, bookingId, ctx);
  }

  /**
   * AUTORIZAR EL DEPÓSITO, con quien alquila presente.
   *
   * El camino normal es otro: cuando el dueño marca el auto listo para
   * retirar, el servidor autoriza el depósito solo, con la tarjeta que dejó
   * guardada el cobro (authorizeDepositForPickup). Esto es el plan B, para
   * cuando el banco pide que la persona se autentique (3-D Secure) y el
   * servidor no puede hacerlo por ella: devuelve el client secret y el front
   * lo confirma con la persona delante.
   */
  async createDepositHold(
    renterId: string,
    bookingId: string,
    ctx: PaymentContext,
  ) {
    const booking = await this.findBookingWithUsers(bookingId);
    if (booking.renterId !== renterId) {
      throw new ForbiddenException("Only the renter can pay for this booking");
    }
    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(
        "The deposit can only be authorized on an accepted booking",
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
    const amountMinor = this.amountForKind(booking, "DEPOSIT_HOLD");
    return this.createOrReuseIntent(booking, "DEPOSIT_HOLD", amountMinor, ctx);
  }

  /**
   * AUTORIZAR EL DEPÓSITO SOLO, CERCA DEL RETIRO.
   *
   * Por qué acá y no al pagar: una retención en tarjeta vence sola (unos 7
   * días, más con autorización extendida). Autorizarla al pagar una reserva
   * de dentro de un mes era autorizar algo que se iba a soltar antes de que
   * nadie retirara el auto. Autorizarla cuando el dueño avisa que el auto
   * está listo la hace durar el alquiler y la ventana de inspección.
   *
   * No lanza por el rechazo del banco: si la tarjeta pide autenticación o no
   * alcanza el límite, devuelve `requiresRenterAction` y quien alquila la
   * autoriza desde el front (createDepositHold).
   */
  async authorizeDepositForPickup(bookingId: string, actorId: string) {
    const booking = await this.findBookingWithUsers(bookingId);
    const vigente = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (vigente) return { authorized: true, requiresRenterAction: false };

    const amountMinor = this.amountForKind(booking, "DEPOSIT_HOLD");
    if (!booking.savedPaymentMethodId) {
      return { authorized: false, requiresRenterAction: true };
    }

    try {
      const customerId = await this.ensureRenterCustomer(booking.renter);
      const intent = await this.provider.createDepositHold({
        bookingId,
        kind: "DEPOSIT_HOLD",
        amountMinor,
        currency: booking.currency,
        customerId,
        transferGroup: booking.transferGroup,
        metadata: { renterId: booking.renterId, ownerId: booking.ownerId },
        idempotencyKey: `booking_${bookingId}_deposit_offsession_${amountMinor}`,
        paymentMethodId: booking.savedPaymentMethodId,
        offSession: true,
      });

      const record = await this.prisma.paymentRecord.create({
        data: {
          bookingId,
          userId: booking.renterId,
          kind: PaymentRecordKind.DEPOSIT_HOLD,
          status: PaymentRecordStatus.REQUIRES_ACTION,
          provider: this.provider.name,
          providerId: intent.id,
          stripePaymentIntentId: intent.id,
          amount: amountMinor / 100,
          amountMinor,
          currency: booking.currency,
          metadata: {
            renterId: booking.renterId,
            ownerId: booking.ownerId,
            offSession: true,
          } as Prisma.InputJsonValue,
        },
      });
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: { depositPaymentIntentId: intent.id },
      });
      await this.recordEvent({
        record,
        bookingId,
        actorId,
        source: "system",
        type: "deposit_hold.offsession.requested",
        status: PaymentRecordStatus.REQUIRES_ACTION,
        amountMinor,
        currency: booking.currency,
      });

      if (intent.status === "requires_capture") {
        await this.onHoldAuthorized(intent.id, undefined, intent);
        return { authorized: true, requiresRenterAction: false };
      }
      return { authorized: false, requiresRenterAction: true };
    } catch (error) {
      // Una tarjeta que pide autenticación o que no tiene cupo es el caso
      // esperado de este camino, no un error del sistema: se le pasa la
      // posta a quien alquila.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `no se pudo autorizar el depósito de ${bookingId} sin el cliente: ${message}`,
      );
      return { authorized: false, requiresRenterAction: true };
    }
  }

  /**
   * Crea el intent de un tramo, o reutiliza uno vivo del mismo tramo SI Y
   * SOLO SI es por el mismo importe y la misma moneda.
   *
   * Esa condición es la que impide cobrar un precio viejo: si el importe
   * cambió entre que se creó el intent y que se paga, se crea uno nuevo.
   */
  private async createOrReuseIntent(
    booking: BookingWithUsers,
    kind: PaymentRecordKindLike,
    amountMinor: number,
    ctx: PaymentContext,
    extra: { setupFutureUsage?: "off_session"; saveCard?: boolean } = {},
  ) {
    const bookingId = booking.id;
    const currency = booking.currency;

    const existing = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: kind as PaymentRecordKind,
        status: { notIn: UNUSABLE_RECORD_STATUSES },
      },
      orderBy: { createdAt: "desc" },
    });
    if (
      existing?.stripePaymentIntentId &&
      existing.amountMinor === amountMinor &&
      existing.currency === currency
    ) {
      // El client secret NO se guarda en la base y se vuelve a pedir acá: es
      // una credencial que permite confirmar el pago de ese intent.
      const vigente = await this.safeRetrieve(existing.stripePaymentIntentId);
      return {
        bookingId,
        kind,
        paymentIntentId: existing.stripePaymentIntentId,
        clientSecret: vigente?.clientSecret ?? null,
        amountMinor: existing.amountMinor ?? amountMinor,
        currency,
        status: existing.status,
        reused: true,
        ticket: this.ticketOf(booking),
      };
    }

    const customerId = await this.ensureRenterCustomer(booking.renter);
    const input = {
      bookingId,
      kind,
      amountMinor,
      currency,
      customerId,
      transferGroup: booking.transferGroup,
      metadata: { renterId: booking.renterId, ownerId: booking.ownerId },
      // El importe va en la clave: sin él, un intent por $100 y otro por $120
      // compartían clave y Stripe devolvía el primero.
      idempotencyKey: `booking_${bookingId}_${kind.toLowerCase()}_${amountMinor}`,
      ...extra,
    };

    const intent =
      kind === "DEPOSIT_HOLD"
        ? await this.provider.createDepositHold(input)
        : await this.provider.createPaymentIntent(input);

    /*
      UPSERT Y NO CREATE, Y ACÁ HAY UN ERROR QUE COSTÓ CARO.

      ── Qué pasaba ─────────────────────────────────────────────────────────
      Una tarjeta rechazada dejaba el registro en FAILED, que este código trata
      como inservible: no lo reutiliza y sale a pedir otro intent. Pero la clave
      de idempotencia es la misma —la reserva, el tramo y el importe no
      cambiaron—, así que Stripe hacía lo correcto y devolvía EL MISMO intent de
      antes. Y ahí esto intentaba INSERTAR un segundo registro con el mismo
      `stripePaymentIntentId`, que es una columna única.

      Resultado: violación de unicidad, un error de Prisma que nadie atrapaba, y
      un 500 mudo "Internal server error" en la pantalla de pago. O sea que
      después de UN rechazo de tarjeta, esa reserva no se podía pagar nunca más:
      cada intento moría con un error que no hablaba de la tarjeta ni del cobro.

      ── Por qué upsert es la respuesta y no una clave distinta ─────────────
      Porque reintentar el MISMO intent es lo que Stripe espera: un intent que
      falló vuelve a `requires_payment_method` y se puede confirmar de nuevo con
      otra tarjeta. Inventarle una clave nueva a cada reintento crearía un
      intent nuevo por cada tarjeta rechazada, que es basura en la cuenta y no
      arregla nada.

      Así que si Stripe devuelve el intent de antes, se reusa su fila y se la
      vuelve a poner a la espera. El historial no se pierde: lo que pasó con ese
      cobro —incluido el rechazo— vive en PaymentEvent, que es append-only y
      para eso está.
    */
    const datos = {
      bookingId,
      userId: booking.renterId,
      kind: kind as PaymentRecordKind,
      status: PaymentRecordStatus.REQUIRES_ACTION,
      provider: this.provider.name,
      providerId: intent.id,
      stripePaymentIntentId: intent.id,
      amount: amountMinor / 100,
      amountMinor,
      currency,
      initiatedIp: ctx.ip ?? null,
      initiatedUserAgent: ctx.userAgent?.slice(0, 500) ?? null,
      // `metadata` ya no lleva el client secret (ver arriba). Lleva las dos
      // partes de la reserva, que es lo que hace falta para reconstruir un
      // cobro sin tener que ir a buscar la reserva.
      metadata: {
        renterId: booking.renterId,
        ownerId: booking.ownerId,
      } as Prisma.InputJsonValue,
    };
    const record = await this.prisma.paymentRecord.upsert({
      where: { stripePaymentIntentId: intent.id },
      create: datos,
      update: {
        status: PaymentRecordStatus.REQUIRES_ACTION,
        provider: this.provider.name,
        providerId: intent.id,
        stripePaymentIntentId: intent.id,
        amount: amountMinor / 100,
        amountMinor,
        currency,
        initiatedIp: ctx.ip ?? null,
        initiatedUserAgent: ctx.userAgent?.slice(0, 500) ?? null,
        metadata: {
          renterId: booking.renterId,
          ownerId: booking.ownerId,
        } as Prisma.InputJsonValue,
      },
    });

    await this.prisma.booking.update({
      where: { id: bookingId },
      data:
        kind === "DEPOSIT_HOLD"
          ? { depositPaymentIntentId: intent.id }
          : { checkoutPaymentIntentId: intent.id },
    });

    await this.recordEvent({
      record,
      bookingId,
      actorId: booking.renterId,
      source: "api",
      type: `${kind.toLowerCase()}.intent.created`,
      status: PaymentRecordStatus.REQUIRES_ACTION,
      amountMinor,
      currency,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    await this.auditLog.create({
      actorId: booking.renterId,
      targetUserId: booking.ownerId,
      action: `payment.${kind.toLowerCase()}.intent_created`,
      entityType: "Booking",
      entityId: bookingId,
      metadata: { paymentIntentId: intent.id, amountMinor },
    });

    return {
      bookingId,
      kind,
      paymentIntentId: intent.id,
      clientSecret: intent.clientSecret,
      amountMinor,
      currency,
      status: record.status,
      reused: false,
      ticket: this.ticketOf(booking),
    };
  }

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

  /** Lo cobrado de verdad en una reserva (alquiler y cobertura), neto de devoluciones. */
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

  // ── Simulación offline (solo con el provider mock, que es el de los tests) ──

  /**
   * Completa el pago de una reserva sin pasar por el procesador.
   *
   * Existe SOLO para los tests automatizados, que corren con
   * PAYMENTS_PROVIDER=mock y no tienen quién les mande un webhook firmado. Con
   * el provider Stripe está deshabilitado (403), y la demo usa Stripe: ahí el
   * pago lo confirma Stripe y el aviso llega por webhook, como en producción.
   */
  async simulatePaymentSuccess(
    renterId: string,
    bookingId: string,
    kind: PaymentRecordKindLike | undefined,
    ctx: PaymentContext,
  ) {
    this.assertMockProvider();
    // Sin tramo: el cobro único y, después, el depósito. Es lo que el front
    // hace de verdad con Stripe, en el mismo orden.
    const kinds: PaymentRecordKindLike[] = kind
      ? [kind]
      : ["CHECKOUT", "DEPOSIT_HOLD"];

    for (const current of kinds) {
      if (current === "DEPOSIT_HOLD") {
        const intent = await this.createDepositHold(renterId, bookingId, ctx);
        await this.onHoldAuthorized(intent.paymentIntentId);
      } else {
        const intent =
          current === "BALANCE"
            ? await this.createBalanceIntent(renterId, bookingId, ctx)
            : await this.createCheckout(renterId, bookingId, ctx);
        await this.onIntentSucceeded(intent.paymentIntentId);
      }
    }

    return this.getStatus(renterId, bookingId);
  }

  /** Contracara de simulatePaymentSuccess: deja el cobro pendiente en FAILED. */
  async simulatePaymentFailure(
    renterId: string,
    bookingId: string,
    kind: PaymentRecordKindLike = "CHECKOUT",
  ) {
    this.assertMockProvider();
    const booking = await this.findBooking(bookingId);
    if (booking.renterId !== renterId) {
      throw new ForbiddenException("Only the renter can pay for this booking");
    }

    const record = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: kind as PaymentRecordKind,
        status: { notIn: UNUSABLE_RECORD_STATUSES },
      },
      orderBy: { createdAt: "desc" },
    });

    if (record?.stripePaymentIntentId) {
      await this.onIntentFailed(record.stripePaymentIntentId);
    } else {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: { paymentStatus: PaymentStatus.FAILED },
      });
    }

    return this.getStatus(renterId, bookingId);
  }

  private assertMockProvider() {
    if (this.provider.name !== "mock") {
      throw new ForbiddenException({
        statusCode: 403,
        code: "SIMULATION_DISABLED",
        message:
          "La simulación de pagos solo existe para los tests automatizados " +
          "(PAYMENTS_PROVIDER=mock). Acá los pagos los confirma Stripe.",
      });
    }
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
    return {
      bookingId,
      paymentStatus: booking.paymentStatus,
      currency: booking.currency,
      total: booking.totalPriceSnapshot,
      sena: booking.senaAmountSnapshot,
      balance: booking.balanceAmountSnapshot,
      deposit: booking.depositSnapshot,
      commission: booking.platformFeeSnapshot,
      insurance: booking.insuranceSnapshot,
      ownerPayout: booking.ownerPayoutSnapshot,
      ownerTransferId: booking.ownerTransferId,
      depositCapturedAmount: booking.depositCapturedAmount,
      depositHoldExpiresAt: booking.depositHoldExpiresAt,
      paidAt: booking.paidAt,
      refundedAt: booking.refundedAt,
      settledAt: booking.settledAt,
      inspectionEndsAt: booking.inspectionEndsAt,
      cancellation: booking.cancellationSettlement,
      ticket: this.ticketOf(booking),
      /** Lo que sigue retenido a nombre de esta reserva, por concepto. */
      heldMinor: pockets,
      records: records.map((record) => publicRecord(record)),
    };
  }

  /**
   * LAS TARJETAS QUE EL PROCESADOR YA TIENE GUARDADAS DE ESTA PERSONA.
   *
   * No devuelve ningún número: marca, últimos cuatro, vencimiento y el
   * identificador con el que el procesador la reconoce, que solo sirve para
   * cobros de este mismo cliente.
   */
  async listSavedCards(userId: string): Promise<{ cards: SavedCard[] }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    assertFound(user, "User not found");
    // Un identificador de otro proveedor (una `cus_mock_…` que quedó de cuando
    // este deploy corría en simulación) no se le manda al procesador: contesta
    // "No such customer" y rompe la pantalla por una comodidad.
    if (!this.esDelProveedorActual(user.stripeCustomerId)) {
      return { cards: [] };
    }
    const cards = await this.provider.listSavedCards(
      user.stripeCustomerId as string,
    );
    return { cards };
  }

  /**
   * Reintentar la liquidación a mano, desde el panel.
   *
   * Es para el caso en que el cierre automático falló —el dueño todavía no
   * había terminado el alta de cobros, el procesador estaba caído— y la
   * reserva quedó devuelta con la plata sin repartir. No duplica nada: cada
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

  /** El ticket de una reserva, para mostrarlo antes de pagar. */
  async getTicket(userId: string, bookingId: string) {
    const booking = await this.findBookingForParticipant(userId, bookingId);
    return this.ticketOf(booking);
  }

  // ── Webhook ────────────────────────────────────────────────────────────

  async handleWebhook(rawBody: Buffer, signature: string | undefined) {
    let event;
    try {
      event = this.provider.constructWebhookEvent(rawBody, signature);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`webhook rechazado: ${message}`);
      throw new BadRequestException("Invalid Stripe webhook signature");
    }

    // UN EVENTO DEL MODO REAL LLEGANDO A UN DEPLOY DE PRUEBA SE DESCARTA.
    //
    // Si esto pasa, algo está cruzado: las claves, o un webhook de la cuenta
    // real apuntado a este proyecto. Procesarlo movería plata de verdad sobre
    // reservas que son de mentira. Se contesta 200 para que Stripe no reintente
    // eternamente, pero no se toca nada.
    if (event.livemode && !this.enModoReal()) {
      this.logger.error(
        `evento livemode ${event.id} (${event.type}) recibido por un deploy ` +
          "en modo de prueba: descartado. Revisar a qué proyecto apunta el " +
          "webhook de la cuenta de Stripe real.",
      );
      return { received: true, ignored: "livemode_mismatch" as const };
    }

    // La unicidad de `eventId` es lo que hace el descarte de duplicados, y se
    // apoya en la base y no en un `findUnique` previo: dos entregas del mismo
    // evento llegando a la vez pasaban las dos por el chequeo y se procesaban
    // dos veces (Stripe reintenta, y reintenta en paralelo).
    try {
      await this.prisma.stripeEvent.create({
        data: {
          eventId: event.id,
          type: event.type,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // Ya procesado, o todavía procesándose por otra entrega: en los dos
        // casos se descarta. El que lo está procesando va a terminar, y si no
        // termina Stripe vuelve a mandarlo (la fila queda sin processedAt, así
        // que se ve cuál quedó a medias).
        return { received: true, duplicate: true as const, type: event.type };
      }
      throw error;
    }

    await this.dispatchEvent(event.id, event.type, event.data.object);

    await this.prisma.stripeEvent.update({
      where: { eventId: event.id },
      data: { processedAt: new Date() },
    });

    return { received: true, duplicate: false as const, type: event.type };
  }

  private async dispatchEvent(
    eventId: string,
    type: string,
    object: Record<string, unknown>,
  ): Promise<void> {
    const id = object.id as string | undefined;
    if (!id) return;

    switch (type) {
      case "payment_intent.succeeded":
        await this.onIntentSucceeded(id, eventId);
        break;
      case "payment_intent.amount_capturable_updated":
        await this.onHoldAuthorized(id, eventId);
        break;
      case "payment_intent.processing":
        await this.onIntentProcessing(id, eventId);
        break;
      case "payment_intent.payment_failed":
        await this.onIntentFailed(id, eventId);
        break;
      case "payment_intent.canceled":
        await this.onIntentCanceled(id, eventId);
        break;
      case "charge.refunded":
        await this.onChargeRefunded(object, eventId);
        break;
      case "charge.dispute.created":
      case "charge.dispute.funds_withdrawn":
        await this.onDisputeOpened(object, eventId);
        break;
      case "account.updated":
        await this.onConnectedAccountUpdated(object, eventId);
        break;
      default:
        // Un evento que no nos interesa no es un error: Stripe manda muchos y
        // suscribirse de más es más seguro que de menos. Queda anotado y ya.
        this.logger.debug(`evento ${type} recibido y no aplicado`);
    }
  }

  /**
   * Un cobro se concretó.
   *
   * Antes de tocar nada se le pregunta al procesador por el intent completo:
   * el webhook trae el id del cargo pero no el cargo, así que la tarjeta y la
   * evaluación de riesgo —lo único que después permite responder un
   * desconocimiento de cobro— solo se consiguen preguntando.
   */
  private async onIntentSucceeded(piId: string, eventId?: string) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record?.bookingId) return;
    const bookingId = record.bookingId;
    const detalle = await this.safeRetrieve(piId);

    // El importe que Stripe dice haber cobrado contra el que esta reserva
    // esperaba. Un desajuste es una señal de manipulación o de un intent que
    // no es de esta reserva; no se revierte solo —la plata ya entró— pero
    // queda gritado en el log y guardado en el registro.
    if (
      detalle?.amountReceivedMinor != null &&
      record.amountMinor != null &&
      detalle.amountReceivedMinor !== record.amountMinor
    ) {
      this.logger.error(
        `el cobro ${piId} entró por ${detalle.amountReceivedMinor} y la ` +
          `reserva ${bookingId} esperaba ${record.amountMinor}`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const actualizado = await tx.paymentRecord.update({
        where: { id: record.id },
        data: {
          status: PaymentRecordStatus.CAPTURED,
          stripeChargeId: detalle?.chargeId ?? undefined,
          paidAt: new Date(),
          capturedAt: new Date(),
          failureCode: null,
          failureMessage: null,
          ...cardColumns(detalle),
        },
      });

      if (record.kind === PaymentRecordKind.CHECKOUT) {
        await tx.booking.update({
          where: { id: bookingId },
          data: {
            paymentStatus: PaymentStatus.FULLY_PAID,
            paidAt: new Date(),
            checkoutPaymentIntentId: piId,
            // La tarjeta queda guardada para autorizar el depósito cerca del
            // retiro sin volver a pedírsela a nadie.
            ...(detalle?.paymentMethodId
              ? { savedPaymentMethodId: detalle.paymentMethodId }
              : {}),
          },
        });
      } else if (record.kind === PaymentRecordKind.SENA) {
        const booking = await tx.booking.findUnique({
          where: { id: bookingId },
          select: { paymentStatus: true },
        });
        if (booking?.paymentStatus === PaymentStatus.PENDING) {
          await tx.booking.update({
            where: { id: bookingId },
            data: {
              paymentStatus: PaymentStatus.DEPOSIT_PAID,
              paidAt: new Date(),
            },
          });
        }
      } else if (record.kind === PaymentRecordKind.BALANCE) {
        const charged = await tx.paymentRecord.findMany({
          where: {
            bookingId,
            kind: { in: [PaymentRecordKind.SENA, PaymentRecordKind.BALANCE] },
            status: { in: PAID_RECORD_STATUSES },
          },
          select: { kind: true },
        });
        const kinds = new Set(charged.map((r) => r.kind));
        if (
          kinds.has(PaymentRecordKind.SENA) &&
          kinds.has(PaymentRecordKind.BALANCE)
        ) {
          await tx.booking.update({
            where: { id: bookingId },
            data: {
              paymentStatus: PaymentStatus.FULLY_PAID,
              paidAt: new Date(),
            },
          });
        }
      }
      return actualizado;
    });

    // La plata que entró queda asentada en los bolsillos de la reserva.
    if (
      record.kind === PaymentRecordKind.CHECKOUT ||
      record.kind === PaymentRecordKind.BALANCE
    ) {
      await this.ensureFundsJournal(bookingId);
    }

    await this.recordEvent({
      record: updated,
      bookingId,
      source: "webhook",
      type: "intent.succeeded",
      status: PaymentRecordStatus.CAPTURED,
      amountMinor: detalle?.amountReceivedMinor ?? record.amountMinor,
      currency: record.currency,
      providerEventId: eventId,
      payload: detalle
        ? { status: detalle.status, chargeId: detalle.chargeId }
        : null,
    });

    await this.auditLog.create({
      action: "payment.intent.succeeded",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { paymentIntentId: piId, kind: record.kind },
    });

    await this.avisarDelPago(bookingId, record.kind, record.amount);
  }

  /** Cómo se llama cada cobro para una persona, no para el código. */
  private static readonly CONCEPTO: Record<string, string> = {
    CHECKOUT: "Pago de la reserva",
    SENA: "Seña",
    BALANCE: "Saldo",
    DEPOSIT_HOLD: "Depósito en garantía",
    DEPOSIT_CAPTURE: "Cobro del depósito en garantía",
  };

  /**
   * Comprobante al inquilino y aviso al dueño, cada vez que un cobro se concreta.
   *
   * Va acá, en onIntentSucceeded, porque es el ÚNICO lugar por donde pasan los
   * dos caminos: el webhook de Stripe y el pago simulado de los tests. Ponerlo
   * en cada uno serían dos lugares para olvidarse de uno.
   *
   * Nunca hace fallar el pago: si el mail no sale, queda en el log. Un cobro que
   * se revierte porque no salió un mail sería mucho peor que un mail perdido.
   */
  private async avisarDelPago(
    bookingId: string,
    kind: PaymentRecordKind | null,
    amount: number | null,
  ): Promise<void> {
    // Sin concepto o sin importe no hay comprobante que tenga sentido mandar.
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
      const vehicleLabel =
        [booking.vehicle?.brand, booking.vehicle?.model, booking.vehicle?.year]
          .filter(Boolean)
          .join(" ") || "el vehículo";
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

      // Lo pagado hasta ahora, para que el comprobante ubique el pago dentro del
      // total en vez de mostrar un número suelto.
      const pagados = await this.prisma.paymentRecord.aggregate({
        where: {
          bookingId,
          kind: { in: [PaymentRecordKind.SENA, PaymentRecordKind.BALANCE] },
          status: { in: PAID_RECORD_STATUSES },
        },
        _sum: { amount: true },
      });

      if (booking.renter?.email) {
        await this.email.sendPaymentReceipt(booking.renter.email, {
          renterName: nombre(booking.renter),
          concepto,
          amount,
          currency: booking.currency,
          vehicleLabel,
          startDate: booking.startDate,
          endDate: booking.endDate,
          totalPaid: pagados._sum.amount ?? undefined,
          bookingId: booking.id,
        });
      }

      // El depósito en garantía es una retención, no plata que cobre el dueño:
      // avisarle que "recibió un pago" por eso sería confundirlo.
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
   * La retención del depósito quedó autorizada: la plata está bloqueada.
   *
   * Se anota hasta cuándo vale (captureBefore): pasado ese momento el emisor
   * la suelta solo, y un daño reclamado después ya no se puede cobrar de ahí.
   */
  private async onHoldAuthorized(
    piId: string,
    eventId?: string,
    known?: PaymentIntentResult,
  ) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record) return;
    const detalle = known ?? (await this.safeRetrieve(piId));

    const updated = await this.prisma.paymentRecord.update({
      where: { id: record.id },
      data: {
        status: PaymentRecordStatus.AUTHORIZED,
        stripeChargeId: detalle?.chargeId ?? undefined,
        ...cardColumns(detalle),
      },
    });

    if (record.bookingId) {
      const vence =
        detalle?.captureBefore ??
        // Sin el dato del procesador se asume lo que dura una retención común.
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await this.prisma.booking.update({
        where: { id: record.bookingId },
        data: { depositHoldExpiresAt: vence },
      });
    }

    await this.recordEvent({
      record: updated,
      bookingId: record.bookingId,
      source: eventId ? "webhook" : "system",
      type: "hold.authorized",
      status: PaymentRecordStatus.AUTHORIZED,
      amountMinor: detalle?.amountCapturableMinor ?? record.amountMinor,
      currency: record.currency,
      providerEventId: eventId,
    });
  }

  /**
   * El medio de pago se está procesando: ni éxito ni fracaso.
   *
   * Existe porque sin este estado un pago en curso se veía igual que uno que
   * nunca se intentó, y el front le mostraba a alguien que ya había pagado el
   * botón de pagar otra vez.
   */
  private async onIntentProcessing(piId: string, eventId?: string) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record) return;
    const updated = await this.prisma.paymentRecord.update({
      where: { id: record.id },
      data: { status: PaymentRecordStatus.PROCESSING },
    });
    await this.recordEvent({
      record: updated,
      bookingId: record.bookingId,
      source: "webhook",
      type: "intent.processing",
      status: PaymentRecordStatus.PROCESSING,
      providerEventId: eventId,
    });
  }

  private async onIntentFailed(piId: string, eventId?: string) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record?.bookingId) return;
    const bookingId = record.bookingId;
    const detalle = await this.safeRetrieve(piId);
    const isCharge =
      record.kind === PaymentRecordKind.SENA ||
      record.kind === PaymentRecordKind.BALANCE;

    const updated = await this.prisma.$transaction(async (tx) => {
      const actualizado = await tx.paymentRecord.update({
        where: { id: record.id },
        data: {
          status: PaymentRecordStatus.FAILED,
          failureCode: detalle?.failure?.code ?? null,
          failureMessage: detalle?.failure?.message ?? null,
          ...cardColumns(detalle),
        },
      });
      if (isCharge) {
        await tx.booking.update({
          where: { id: bookingId },
          data: { paymentStatus: PaymentStatus.FAILED },
        });
      }
      return actualizado;
    });

    await this.recordEvent({
      record: updated,
      bookingId,
      source: "webhook",
      type: "intent.failed",
      status: PaymentRecordStatus.FAILED,
      amountMinor: record.amountMinor,
      currency: record.currency,
      providerEventId: eventId,
      payload: detalle?.failure ? { ...detalle.failure } : null,
    });
  }

  private async onIntentCanceled(piId: string, eventId?: string) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record) return;
    // Cancelar una retención ES soltarla: para quien alquiló, su plata se
    // desbloqueó. Distinguirlo de un intent de cobro cancelado importa porque
    // son dos cosas distintas para quien lee el historial.
    const esRetencion = record.kind === PaymentRecordKind.DEPOSIT_HOLD;
    const status = esRetencion
      ? PaymentRecordStatus.RELEASED
      : PaymentRecordStatus.CANCELLED;

    const updated = await this.prisma.paymentRecord.update({
      where: { id: record.id },
      data: {
        status,
        ...(esRetencion ? { releasedAt: new Date() } : {}),
      },
    });
    await this.recordEvent({
      record: updated,
      bookingId: record.bookingId,
      source: "webhook",
      type: esRetencion ? "hold.released" : "intent.canceled",
      status,
      providerEventId: eventId,
    });
  }

  /**
   * Una devolución se concretó del lado del procesador.
   *
   * Llega también cuando la devolución la inició alguien desde el panel de
   * Stripe y no desde acá, que es justamente el caso que antes dejaba la base
   * diciendo "cobrado" sobre plata que ya se había devuelto.
   */
  private async onChargeRefunded(
    object: Record<string, unknown>,
    eventId?: string,
  ) {
    const piId = object.payment_intent as string | undefined;
    if (!piId) return;
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record) return;

    const refundedMinor = Number(object.amount_refunded ?? 0);
    const totalMinor = Number(object.amount ?? record.amountMinor ?? 0);
    const completa = refundedMinor >= totalMinor && totalMinor > 0;

    const updated = await this.prisma.paymentRecord.update({
      where: { id: record.id },
      data: {
        status: completa
          ? PaymentRecordStatus.REFUNDED
          : PaymentRecordStatus.PARTIALLY_REFUNDED,
        refundedAmountMinor: refundedMinor,
        refundedAt: new Date(),
      },
    });

    if (completa && record.bookingId) {
      await this.prisma.booking.update({
        where: { id: record.bookingId },
        data: {
          paymentStatus: PaymentStatus.REFUNDED,
          refundedAt: new Date(),
        },
      });
    }

    await this.recordEvent({
      record: updated,
      bookingId: record.bookingId,
      source: "webhook",
      type: completa ? "refund.completed" : "refund.partial",
      status: updated.status,
      amountMinor: refundedMinor,
      currency: record.currency,
      providerEventId: eventId,
    });
  }

  /**
   * EL TITULAR DE LA TARJETA DESCONOCIÓ EL COBRO.
   *
   * Es el evento más caro de todos: la plata se va, y se va del saldo de la
   * plataforma. Lo importante acá es que quede MARCADO antes de que se le
   * transfiera nada al dueño del auto — si el pago se revierte después de
   * haberle pagado, la pérdida la come la plataforma entera.
   *
   * Por eso `settleOnReturn` se niega a liquidar una reserva con una disputa
   * abierta.
   */
  private async onDisputeOpened(
    object: Record<string, unknown>,
    eventId?: string,
  ) {
    const chargeId = object.charge as string | undefined;
    const piId = object.payment_intent as string | undefined;
    const record = piId
      ? await this.prisma.paymentRecord.findUnique({
          where: { stripePaymentIntentId: piId },
        })
      : chargeId
        ? await this.prisma.paymentRecord.findFirst({
            where: { stripeChargeId: chargeId },
          })
        : null;
    if (!record) return;

    const updated = await this.prisma.paymentRecord.update({
      where: { id: record.id },
      data: {
        status: PaymentRecordStatus.DISPUTED,
        disputedAt: new Date(),
      },
    });

    if (record.bookingId) {
      await this.prisma.booking.update({
        where: { id: record.bookingId },
        data: { paymentStatus: PaymentStatus.DISPUTED },
      });
    }

    await this.recordEvent({
      record: updated,
      bookingId: record.bookingId,
      source: "webhook",
      type: "dispute.opened",
      status: PaymentRecordStatus.DISPUTED,
      amountMinor: Number(object.amount ?? record.amountMinor ?? 0),
      currency: record.currency,
      providerEventId: eventId,
      payload: { reason: object.reason ?? null, status: object.status ?? null },
    });

    this.logger.error(
      `DISPUTA abierta sobre ${record.stripePaymentIntentId} ` +
        `(reserva ${record.bookingId}). La liquidación al dueño queda frenada.`,
    );

    await this.auditLog.create({
      targetUserId: record.userId ?? undefined,
      action: "payment.dispute.opened",
      entityType: "Booking",
      entityId: record.bookingId ?? "",
      metadata: {
        paymentIntentId: record.stripePaymentIntentId,
        reason: object.reason ?? null,
      },
    });
  }

  /**
   * La cuenta conectada de un dueño cambió de estado.
   *
   * Sin esto, `stripeAccountStatus` se quedaba en PENDING para siempre: se
   * escribía al empezar el alta y nadie volvía a mirarlo. El resultado era que
   * la plataforma intentaba transferirle a cuentas que Stripe había
   * restringido, y la transferencia fallaba en el peor momento posible — al
   * devolver el auto.
   */
  private async onConnectedAccountUpdated(
    object: Record<string, unknown>,
    eventId?: string,
  ) {
    const accountId = object.id as string | undefined;
    if (!accountId) return;

    const owner = await this.prisma.user.findUnique({
      where: { stripeAccountId: accountId },
      select: { id: true },
    });
    if (!owner) return;

    const chargesEnabled = object.charges_enabled === true;
    const payoutsEnabled = object.payouts_enabled === true;
    const detailsSubmitted = object.details_submitted === true;

    const status = payoutsEnabled
      ? StripeAccountStatus.ENABLED
      : detailsSubmitted
        ? StripeAccountStatus.RESTRICTED
        : StripeAccountStatus.PENDING;

    await this.prisma.user.update({
      where: { id: owner.id },
      data: { stripeAccountStatus: status },
    });

    await this.prisma.paymentEvent.create({
      data: {
        actorId: null,
        source: "webhook",
        type: "connect.account.updated",
        providerEventId: eventId ?? null,
        payload: {
          accountId,
          chargesEnabled,
          payoutsEnabled,
          detailsSubmitted,
          status,
        } as Prisma.InputJsonValue,
      },
    });
  }

  // ── Puerta del retiro ──────────────────────────────────────────────────

  async assertReadyForPickup(bookingId: string): Promise<void> {
    const booking = await this.findBooking(bookingId);
    if (booking.paymentStatus !== PaymentStatus.FULLY_PAID) {
      throw new BadRequestException({
        statusCode: 400,
        code: "CHECKOUT_NOT_PAID",
        message: "La reserva tiene que estar paga antes del retiro.",
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
      throw new ConflictException({
        statusCode: 409,
        code: "DEPOSIT_AUTHORIZATION_REQUIRED",
        message:
          "El depósito en garantía no está autorizado. Quien alquila tiene " +
          "que autorizarlo desde la reserva (POST /payments/bookings/:id/deposit-hold).",
      });
    }
  }

  // ── El libro: la plata de una reserva, en sus bolsillos ───────────────

  /**
   * Asienta que la plata de una reserva ENTRÓ y la reparte en sus bolsillos:
   * seña, resto del alquiler y cobertura, todo retenido a nombre de la reserva.
   *
   * Es idempotente y se puede llamar en cualquier momento: el webhook del cobro
   * lo llama al confirmarse el pago, y la liquidación o la cancelación lo
   * vuelven a llamar por las dudas —para las reservas pagadas con el flujo
   * viejo, que nunca pasaron por acá—. Se reparte lo efectivamente cobrado, en
   * este orden: primero la seña, después el resto del alquiler, al final la
   * cobertura.
   */
  async ensureFundsJournal(
    bookingId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const clave = `funds:${bookingId}`;
    if (await this.ledger.exists(clave, db)) return;

    const booking = await db.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return;
    const cobrado = await this.capturedMinor(bookingId, db);
    if (cobrado <= 0) return;

    const ticket = this.ticketOf(booking);
    const sena = Math.min(ticket.sena.amountMinor, cobrado);
    const alquiler = Math.min(
      ticket.lines.find((l) => l.code === "RENTAL_REST")?.amountMinor ?? 0,
      cobrado - sena,
    );
    const cobertura = cobrado - sena - alquiler;

    await this.ledger.post(
      {
        idempotencyKey: clave,
        type: "funds.captured",
        description: "Pago de la reserva, retenido en sus bolsillos",
        currency: booking.currency,
        bookingId,
        lines: [
          { account: Accounts.processorClearing(), amountMinor: -cobrado },
          { account: Accounts.bookingSena(bookingId), amountMinor: sena },
          { account: Accounts.bookingRental(bookingId), amountMinor: alquiler },
          {
            account: Accounts.bookingInsurance(bookingId),
            amountMinor: cobertura,
          },
        ],
      },
      db,
    );
  }

  /** Lo que queda retenido en cada bolsillo de una reserva. */
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
   * LIQUIDA UNA RESERVA: suelta (o cobra) el depósito, reparte la plata
   * retenida y le paga al dueño.
   *
   * Solo se puede cuando la ventana de inspección se cerró sin reclamo, o el
   * reclamo quedó resuelto. Es IDEMPOTENTE: la puede pedir el cron, una de las
   * partes o un admin, y aunque la pidan a la vez se liquida una sola vez
   * (`settledAt` y la idempotencia del libro lo garantizan).
   *
   * El pago al dueño NO es condición para cerrar la reserva. Si la
   * transferencia falla —la cuenta del dueño todavía no puede recibir, el
   * procesador está caído— la plata queda en su bolsillo (owner:payable) y se
   * reintenta en la próxima corrida. Antes una transferencia fallida hacía
   * fallar la devolución entera, y la reserva quedaba trabada con el auto ya
   * devuelto.
   */
  async settleBooking(
    bookingId: string,
    actorId: string | null,
    opts: { now?: Date } = {},
  ): Promise<{ settled: boolean; reason?: string }> {
    const now = opts.now ?? new Date();
    const booking = await this.findBookingWithUsers(bookingId);
    if (booking.settledAt) return { settled: true, reason: "ALREADY_SETTLED" };

    // UNA CONTRACARA BANCARIA FRENA TODO.
    //
    // Si el banco de quien alquiló desconoció el cobro, esa plata puede
    // volverse atrás: transferírsela al dueño ahora la convierte en una
    // pérdida nuestra, porque al dueño ya no se la sacamos. Queda esperando a
    // que alguien mire el caso.
    //
    // Ojo con los dos "DISPUTED" que hay acá: PaymentStatus.DISPUTED es el
    // desconocimiento del cobro en el banco; BookingStatus.DISPUTED, más
    // abajo, es un reclamo por daños entre las partes. No tienen nada que ver
    // entre sí y se tratan distinto.
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

    // 2. La plata retenida de la reserva pasa a quien le corresponde.
    const { sena, rental, insurance } = await this.pockets(bookingId);
    const bruto = sena + rental;
    const comision = Math.round(bruto * this.commissionPct(booking));
    await this.ledger.post({
      idempotencyKey: `settle:${bookingId}`,
      type: "booking.settled",
      description: "Liquidación de la reserva al cerrar la inspección",
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
        // La cobertura es de la aseguradora: pasa a una deuda con ella, no a
        // una cuenta de FreeWheel.
        { account: Accounts.insurancePayable(), amountMinor: insurance },
      ],
    });

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
      metadata: {
        ownerGrossMinor: bruto,
        commissionMinor: comision,
        damagesMinor: aprobado,
      },
    });

    // 3. Pagarle al dueño lo que se le debe. Si falla, queda debido.
    await this.payOwner(booking.owner, `settle:${bookingId}`, actorId);

    return { settled: true };
  }

  /**
   * Le transfiere al dueño TODO lo que se le debe (su bolsillo owner:payable),
   * que puede incluir liquidaciones anteriores que no se pudieron pagar y
   * descontar una deuda suya (una seña doblada por haber cancelado).
   */
  async payOwner(
    owner: User,
    reference: string,
    actorId: string | null,
  ): Promise<{ paidMinor: number; pending: boolean }> {
    const debido = await this.ledger.balance(Accounts.ownerPayable(owner.id));
    if (debido <= 0) return { paidMinor: 0, pending: false };

    try {
      const accountId = await this.ensureOwnerAccount(owner);
      const currency =
        (
          await this.prisma.ledgerEntry.findFirst({
            where: { account: Accounts.ownerPayable(owner.id) },
            orderBy: { createdAt: "desc" },
            select: { currency: true },
          })
        )?.currency ?? "usd";
      const transfer = await this.provider.transferToOwner({
        amountMinor: debido,
        currency,
        destination: accountId,
        metadata: { ownerId: owner.id, reference },
        idempotencyKey: `payout_${owner.id}_${reference}_${debido}`,
      });

      await this.prisma.$transaction(async (tx) => {
        await this.ledger.post(
          {
            idempotencyKey: `payout:${transfer.id}`,
            type: "owner.payout",
            description: "Transferencia al dueño",
            currency,
            actorId,
            lines: [
              {
                account: Accounts.ownerPayable(owner.id),
                amountMinor: -debido,
              },
              { account: Accounts.processorClearing(), amountMinor: debido },
            ],
          },
          tx,
        );
        const bookingId = reference.startsWith("settle:")
          ? reference.slice("settle:".length)
          : null;
        const payout = await tx.paymentRecord.create({
          data: {
            bookingId,
            userId: owner.id,
            kind: PaymentRecordKind.OWNER_TRANSFER,
            status: PaymentRecordStatus.PAID,
            provider: this.provider.name,
            providerId: transfer.id,
            stripeTransferId: transfer.id,
            amount: debido / 100,
            amountMinor: debido,
            currency,
            paidAt: new Date(),
          },
        });
        if (bookingId) {
          await tx.booking.update({
            where: { id: bookingId },
            data: { ownerTransferId: transfer.id },
          });
        }
        await tx.paymentEvent.create({
          data: {
            paymentRecordId: payout.id,
            bookingId,
            actorId,
            source: "system",
            type: "transfer.created",
            status: PaymentRecordStatus.PAID,
            amountMinor: debido,
            currency,
          },
        });
      });
      return { paidMinor: debido, pending: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `no se pudo pagar al dueño ${owner.id} (${debido}): ${message}. ` +
          "Queda debido en su bolsillo y se reintenta en la próxima corrida.",
      );
      await this.prisma.paymentEvent.create({
        data: {
          actorId,
          source: "system",
          type: "transfer.failed",
          amountMinor: debido,
          payload: {
            ownerId: owner.id,
            reference,
            error: message.slice(0, 300),
          },
        },
      });
      return { paidMinor: 0, pending: true };
    }
  }

  /** Reintenta el pago a los dueños que tienen plata debida. Lo corre el cron. */
  async retryPendingPayouts(): Promise<number> {
    const saldos = await this.ledger.balances({ prefix: "owner:" });
    let pagados = 0;
    for (const saldo of saldos) {
      if (saldo.balanceMinor <= 0) continue;
      const ownerId = /^owner:([^:]+):payable$/.exec(saldo.account)?.[1];
      if (!ownerId) continue;
      const owner = await this.prisma.user.findUnique({
        where: { id: ownerId },
      });
      if (!owner) continue;
      const r = await this.payOwner(
        owner,
        `retry:${ownerId}:${saldo.balanceMinor}`,
        null,
      );
      if (r.paidMinor > 0) pagados += 1;
    }
    return pagados;
  }

  /** Suelta la retención del depósito, si la había. */
  private async releaseDepositHold(bookingId: string, actorId: string | null) {
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (!hold?.stripePaymentIntentId) return;
    try {
      await this.provider.releaseHold({
        paymentIntentId: hold.stripePaymentIntentId,
        idempotencyKey: `booking_${bookingId}_deposit_release`,
      });
    } catch (error) {
      // Una retención que ya venció no se puede cancelar: el emisor la soltó
      // solo. Para quien alquiló el resultado es el mismo.
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
    });
    await this.avisarDeLaLiberacion(bookingId, hold);
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

  /**
   * EL MAIL DE "SE LIBERÓ TU DEPÓSITO".
   *
   * Hace falta porque el depósito es la única plata del alquiler que quien
   * alquiló ve salir y no ve volver: no es un cobro, es una retención, así que
   * liberarla no genera ningún movimiento en el resumen de la tarjeta. Sin un
   * mail, la única señal es que el saldo disponible deja de estar recortado, y
   * eso nadie lo mira.
   *
   * NUNCA HACE FALLAR LA LIQUIDACIÓN: la plata ya se soltó cuando esto corre, y
   * una excepción acá desharía por un mail algo que salió bien.
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

  /**
   * LOS MAILS DE "SE COBRÓ PARTE DEL DEPÓSITO", A LAS DOS PARTES.
   *
   * No hace fallar la captura: la plata ya se movió cuando esto corre, y
   * deshacerla por un mail que no salió sería cambiar un problema chico por
   * uno grande.
   */
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

  /**
   * COBRAR UN DAÑO DEL DEPÓSITO.
   *
   * Nunca más de lo retenido, y solo mientras la retención siga viva. Lo
   * cobrado es del dueño (no lleva comisión: es una indemnización, no un
   * alquiler). Devuelve lo que efectivamente se cobró, que puede ser menos de
   * lo aprobado; la diferencia es un reclamo que se sigue por fuera de la
   * plataforma.
   */
  async captureDamage(
    bookingId: string,
    approvedMinor: number,
    reference: string,
    actorId: string | null,
    ctx: PaymentContext = {},
  ): Promise<{ capturedMinor: number; reason?: string }> {
    const booking = await this.findBooking(bookingId);
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (!hold?.stripePaymentIntentId) {
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

    const captured = await this.provider.captureHold({
      paymentIntentId: hold.stripePaymentIntentId,
      amountMinor: monto,
      idempotencyKey: `booking_${bookingId}_deposit_capture_${monto}`,
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      const actualizado = await tx.paymentRecord.update({
        where: { id: hold.id },
        data: {
          status: PaymentRecordStatus.CAPTURED,
          amount: monto / 100,
          amountMinor: monto,
          capturedAt: new Date(),
          paidAt: new Date(),
          stripeChargeId: captured.chargeId ?? undefined,
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
      await this.ledger.post(
        {
          idempotencyKey: `damage:${bookingId}`,
          type: "deposit.captured",
          description: "Cobro de un daño del depósito en garantía",
          currency: hold.currency,
          bookingId,
          actorId,
          lines: [
            { account: Accounts.processorClearing(), amountMinor: -monto },
            {
              account: Accounts.ownerPayable(booking.ownerId),
              amountMinor: monto,
            },
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
   */
  async cancelAndSettle(
    bookingId: string,
    cancelledBy: CancelledBy,
    actorId: string,
    /*
      El tramo lo decide bookings/cancellation-policy.ts mirando cuánto falta
      para el inicio, y entra por acá ya resuelto. Por omisión, "tardia": es el
      tramo que retiene la seña, así que quien llame sin decir nada no regala
      plata del dueño por olvidarse un parámetro.
    */
    opciones: { tier: "libre" | "tardia" } = { tier: "tardia" },
  ): Promise<CancellationOutcome> {
    const booking = await this.findBookingWithUsers(bookingId);
    const outcome = await this.cancellationOutcome(
      booking,
      cancelledBy,
      new Date(),
      opciones,
    );

    if (outcome.rule !== "UNPAID") {
      await this.ensureFundsJournal(bookingId);
      if (outcome.refundToRenterMinor > 0) {
        await this.refundRenter(
          bookingId,
          outcome.refundToRenterMinor,
          actorId,
        );
      }

      const { sena, rental, insurance } = await this.pockets(bookingId);
      const aDevolver = outcome.refundToRenterMinor;
      const lines =
        outcome.rule === "RENTER_FORFEITS_SENA"
          ? [
              // La seña va al dueño (menos la comisión); el resto se devolvió.
              { account: Accounts.bookingSena(bookingId), amountMinor: -sena },
              {
                account: Accounts.ownerPayable(booking.ownerId),
                amountMinor: outcome.ownerReceivesMinor,
              },
              {
                account: Accounts.platformCommission(),
                amountMinor: outcome.platformReceivesMinor,
              },
              {
                account: Accounts.bookingRental(bookingId),
                amountMinor: -rental,
              },
              {
                account: Accounts.bookingInsurance(bookingId),
                amountMinor: -insurance,
              },
              { account: Accounts.processorClearing(), amountMinor: aDevolver },
              // Si la seña retenida no coincide al centavo con la que se
              // calculó (una reserva vieja), la diferencia cierra acá.
              {
                account: Accounts.processorClearing(),
                amountMinor:
                  sena +
                  rental +
                  insurance -
                  outcome.ownerReceivesMinor -
                  outcome.platformReceivesMinor -
                  aDevolver,
              },
            ]
          : [
              { account: Accounts.bookingSena(bookingId), amountMinor: -sena },
              {
                account: Accounts.bookingRental(bookingId),
                amountMinor: -rental,
              },
              {
                account: Accounts.bookingInsurance(bookingId),
                amountMinor: -insurance,
              },
              {
                account: Accounts.processorClearing(),
                amountMinor: sena + rental + insurance,
              },
            ];
      await this.ledger.post({
        idempotencyKey: `cancel:${bookingId}`,
        type: `booking.cancelled.${outcome.rule.toLowerCase()}`,
        description: outcome.explanation,
        currency: booking.currency,
        bookingId,
        actorId,
        lines,
      });

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
      actorId,
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

    if (outcome.ownerReceivesMinor > 0) {
      await this.payOwner(booking.owner, `cancel:${bookingId}`, actorId);
    }
    return outcome;
  }

  /** Mantiene el nombre viejo: cancelar con reembolso total. */
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

  /**
   * Devuelve a la tarjeta de quien alquiló, repartiendo entre los cobros de la
   * reserva (el único nuevo, o la seña y el saldo de una reserva vieja). Nunca
   * más de lo que queda sin devolver en cada uno.
   */
  private async refundRenter(
    bookingId: string,
    amountMinor: number,
    actorId: string,
  ) {
    let pendiente = amountMinor;
    const cobros = await this.prisma.paymentRecord.findMany({
      where: {
        bookingId,
        kind: {
          in: [
            PaymentRecordKind.CHECKOUT,
            PaymentRecordKind.BALANCE,
            PaymentRecordKind.SENA,
          ],
        },
        status: {
          in: [...PAID_RECORD_STATUSES, PaymentRecordStatus.PARTIALLY_REFUNDED],
        },
      },
      orderBy: { createdAt: "desc" },
    });

    for (const record of cobros) {
      if (pendiente <= 0) break;
      if (!record.stripePaymentIntentId) continue;
      const disponible =
        (record.amountMinor ?? 0) - (record.refundedAmountMinor ?? 0);
      const monto = Math.min(disponible, pendiente);
      if (monto <= 0) continue;

      const refund = await this.provider.refund({
        paymentIntentId: record.stripePaymentIntentId,
        amountMinor: monto,
        idempotencyKey: `booking_${bookingId}_${record.id}_refund_${monto}`,
      });
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
            stripeRefundId: refund.id,
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
      pendiente -= monto;
    }

    if (pendiente > 0) {
      this.logger.error(
        `no alcanzó lo cobrado para devolver ${amountMinor} en ${bookingId}: faltaron ${pendiente}`,
      );
    }
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

  // ── Alta del dueño en Connect ──────────────────────────────────────────

  async createOwnerOnboarding(ownerId: string) {
    const owner = await this.prisma.user.findUnique({ where: { id: ownerId } });
    assertFound(owner, "User not found");

    const frontend =
      this.config.get<string>("FRONTEND_URL") ?? "http://localhost:3000";
    const result = await this.provider.createConnectedAccount({
      userId: owner.id,
      email: owner.email,
      refreshUrl: `${frontend}/connect/refresh`,
      returnUrl: `${frontend}/connect/return`,
    });

    await this.prisma.user.update({
      where: { id: owner.id },
      data: {
        stripeAccountId: result.accountId,
        stripeAccountStatus: StripeAccountStatus.PENDING,
      },
    });

    return { accountId: result.accountId, onboardingUrl: result.onboardingUrl };
  }

  /**
   * El estado de cobro del dueño, consultado al procesador.
   *
   * El front lo necesita para poder decir "todavía te falta completar tus
   * datos en Stripe" antes de que alguien publique un auto y descubra recién
   * al devolverlo que no puede cobrar.
   */
  async getOwnerPayoutStatus(ownerId: string) {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { stripeAccountId: true, stripeAccountStatus: true },
    });
    assertFound(owner, "User not found");

    /*
      Una cuenta que quedó de la simulación se trata como "todavía no tiene".

      Preguntarle por ella a Stripe da "No such account", y decirle a alguien
      que su cuenta de cobro está rota cuando lo que hay que hacer es crearla
      lo manda a buscar un problema que no existe. Así, el front le ofrece
      hacer el alta, que es exactamente lo que corresponde.

      El identificador se copia a una constante para que TypeScript sepa que
      después del `if` ya no puede ser null: la comprobación es una llamada a
      un método, y eso no alcanza para que estreche el tipo solo.
    */
    const cuentaDeCobro = owner.stripeAccountId;
    if (!this.esDelProveedorActual(cuentaDeCobro)) {
      return {
        connected: false,
        status: StripeAccountStatus.NONE,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
      };
    }

    const estado = await this.provider.getConnectedAccountStatus(
      cuentaDeCobro as string,
    );
    const status = estado.payoutsEnabled
      ? StripeAccountStatus.ENABLED
      : estado.detailsSubmitted
        ? StripeAccountStatus.RESTRICTED
        : StripeAccountStatus.PENDING;

    if (status !== owner.stripeAccountStatus) {
      await this.prisma.user.update({
        where: { id: ownerId },
        data: { stripeAccountStatus: status },
      });
    }

    return { connected: true, status, ...estado };
  }

  // ── Registro append-only ───────────────────────────────────────────────

  /**
   * Anota una línea en el registro de lo que le pasó a un cobro.
   *
   * NUNCA HACE FALLAR LA OPERACIÓN QUE LA MOTIVÓ. Es deliberado y vale la pena
   * ser explícito: el registro es importante, pero revertir un cobro que ya se
   * hizo porque no se pudo escribir una línea de auditoría sería cambiar un
   * problema de trazabilidad por uno de plata. Si falla, queda gritado en el
   * log, que es donde alguien lo va a ver.
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
          // El id del evento del procesador lleva el tipo pegado: un mismo
          // evento de Stripe puede producir más de una línea (el cobro y el
          // aviso), y el unique las haría chocar.
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
        return; // El mismo evento ya quedó anotado: es el caso normal de un reintento.
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `no se pudo anotar el evento ${input.type} del cobro ` +
          `${input.record?.id ?? "(sin registro)"}: ${message}`,
      );
    }
  }

  /**
   * El historial completo de una reserva: cada línea, en orden.
   *
   * Lo ven las dos partes de la reserva y los administradores. Va SIN las
   * señas de la tarjeta ni la IP para quien no es administrador: al inquilino
   * le sirve ver qué pasó y cuándo, no de qué IP se pagó.
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

  // ── Ayudantes ──────────────────────────────────────────────────────────

  /**
   * Consulta el intent y NO LANZA: si el procesador no contesta, se sigue con
   * lo que ya se sabe.
   *
   * Es una consulta para enriquecer el registro, no para decidir. Hacerla
   * obligatoria significaría que una caída momentánea de Stripe deje un cobro
   * exitoso sin aplicar, que es exactamente al revés de lo que conviene.
   */
  private async safeRetrieve(
    paymentIntentId: string,
  ): Promise<PaymentIntentResult | null> {
    try {
      return await this.provider.retrieveIntent(paymentIntentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `no se pudo consultar el intent ${paymentIntentId}: ${message}`,
      );
      return null;
    }
  }

  /** Si este deploy está configurado para mover plata de verdad. */
  private enModoReal(): boolean {
    return /^(sk|rk)_live_/.test(
      this.config.get<string>("STRIPE_SECRET_KEY") ?? "",
    );
  }

  /**
   * SI UN IDENTIFICADOR GUARDADO LO CREÓ EL PROVEEDOR QUE ESTÁ CORRIENDO HOY.
   *
   * ── El problema que esto resuelve ────────────────────────────────────────
   * Los identificadores de cliente y de cuenta se guardan en la base la
   * primera vez y se reusan siempre. Eso está bien mientras el proveedor no
   * cambie. Pero este deploy corrió un tiempo con PAYMENTS_PROVIDER=mock, y el
   * proveedor de simulación inventa identificadores propios —`cus_mock_…`,
   * `acct_mock_…`— que quedaron escritos en las filas de quienes usaron la app
   * en ese momento.
   *
   * Al pasar a Stripe de verdad, esas filas siguen teniendo el identificador
   * viejo. Se reusa, se le manda a Stripe, y Stripe contesta lo único que
   * puede contestar: "No such customer: 'cus_mock_…'". El cobro falla, y no
   * hay nada en la app que explique por qué: la cuenta parece normal y la
   * tarjeta es válida.
   *
   * No se arregla borrando esas filas a mano, porque vuelve a pasar con cada
   * cuenta que quede de un modo anterior. Se arregla acá: un identificador que
   * no es de este proveedor vale lo mismo que no tener ninguno, y se crea uno
   * nuevo.
   *
   * Sirve para los dos lados: un identificador real guardado mientras corre la
   * simulación también es inservible, y esta misma cuenta lo detecta.
   *
   * ── Lo que NO detecta ────────────────────────────────────────────────────
   * Un identificador de OTRA cuenta de Stripe (si se cambia la clave secreta
   * por la de otra cuenta). Eso solo se sabe preguntándole a Stripe, que es
   * una llamada de red en cada cobro para un caso que pasa una vez en la vida.
   * Cuando pasa, el filtro de errores ya lo dice con todas las letras.
   */
  private esDelProveedorActual(id: string | null | undefined): boolean {
    if (!id) return false;
    const deSimulacion = id.includes("_mock_");
    return deSimulacion === (this.provider.name === "mock");
  }

  private async ensureRenterCustomer(renter: User): Promise<string> {
    if (this.esDelProveedorActual(renter.stripeCustomerId)) {
      return renter.stripeCustomerId as string;
    }
    const customerId = await this.provider.ensureCustomer({
      userId: renter.id,
      email: renter.email,
      name: renter.displayName ?? `${renter.firstName} ${renter.lastName}`,
    });
    await this.prisma.user.update({
      where: { id: renter.id },
      data: { stripeCustomerId: customerId },
    });
    return customerId;
  }

  private async ensureOwnerAccount(owner: User): Promise<string> {
    // Mismo caso que en ensureRenterCustomer: una `acct_mock_…` guardada
    // cuando corría la simulación hace fallar la transferencia al dueño al
    // final del alquiler, que es el peor momento para enterarse.
    if (this.esDelProveedorActual(owner.stripeAccountId)) {
      return owner.stripeAccountId as string;
    }
    const account = await this.provider.createConnectedAccount({
      userId: owner.id,
      email: owner.email,
    });
    await this.prisma.user.update({
      where: { id: owner.id },
      data: {
        stripeAccountId: account.accountId,
        // PENDING y no ENABLED: una cuenta recién creada NO puede recibir
        // plata hasta que su dueño complete el alta con Stripe. Marcarla como
        // habilitada era una mentira que se descubría al fallar la primera
        // transferencia; el estado real llega por el webhook account.updated.
        stripeAccountStatus: StripeAccountStatus.PENDING,
      },
    });
    return account.accountId;
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
      // El vehículo viene para poder nombrarlo en los mails: "se liberó tu
      // depósito de Toyota Corolla 2022" dice de cuál de las tres reservas
      // está hablando, y "se liberó tu depósito" no.
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
  include: { owner: true; renter: true };
}>;

/** Las columnas de tarjeta y riesgo, solo cuando hay algo que escribir. */
function cardColumns(detalle: PaymentIntentResult | null) {
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
 * La fila completa NO se devuelve, y el motivo es concreto: desde que el
 * registro guarda el fingerprint de la tarjeta, la IP y el navegador de quien
 * pagó, devolverla entera le mostraría al dueño del auto desde dónde se conecta
 * quien se lo alquiló. Eso es vigilancia, no información de pago.
 *
 * Lo que queda es lo que sirve para entender el cobro: cuánto, cuándo, en qué
 * estado, con qué tarjeta (marca y últimos cuatro, que es lo que la persona
 * necesita para reconocerla en su resumen) y por qué falló si falló.
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
