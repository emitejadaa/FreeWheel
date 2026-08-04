import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Booking,
  BookingStatus,
  PaymentRecordKind,
  PaymentRecordStatus,
  PaymentStatus,
  Prisma,
  StripeAccountStatus,
  User,
} from "@prisma/client";
import { AuditLogService } from "../common/services/audit-log.service";
import { assertFound } from "../common/utils/entity.util";
import { assertParticipant } from "../common/utils/authorization.util";
import { PrismaService } from "../prisma/prisma.service";
import { PAYMENT_PROVIDER } from "./providers/payment-provider.interface";
import type {
  PaymentProvider,
  PaymentRecordKindLike,
} from "./providers/payment-provider.interface";

const PAID_RECORD_STATUSES: PaymentRecordStatus[] = [
  PaymentRecordStatus.PAID,
  PaymentRecordStatus.CAPTURED,
];

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
  ) {}

  // ---- intent creation (renter, on demand) --------------------------------

  createSenaIntent(renterId: string, bookingId: string) {
    return this.createChargeIntent(renterId, bookingId, "SENA");
  }

  async createBalanceIntent(renterId: string, bookingId: string) {
    const booking = await this.findBooking(bookingId);
    if (booking.paymentStatus === PaymentStatus.PENDING) {
      throw new BadRequestException(
        "Pay the deposit (seña) before the balance",
      );
    }
    return this.createChargeIntent(renterId, bookingId, "BALANCE");
  }

  createDepositHold(renterId: string, bookingId: string) {
    return this.createChargeIntent(renterId, bookingId, "DEPOSIT_HOLD");
  }

  private async createChargeIntent(
    renterId: string,
    bookingId: string,
    kind: PaymentRecordKindLike,
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

    const amountMinor = this.amountForKind(booking, kind);
    const currency = booking.currency;

    // Idempotent: reuse a non-failed intent of the same kind if present.
    const existing = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: kind as PaymentRecordKind,
        status: { notIn: [PaymentRecordStatus.FAILED] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing?.stripePaymentIntentId) {
      const meta = (existing.metadata as Record<string, unknown> | null) ?? {};
      return {
        bookingId,
        kind,
        paymentIntentId: existing.stripePaymentIntentId,
        clientSecret: (meta.clientSecret as string | undefined) ?? null,
        amountMinor: existing.amountMinor ?? amountMinor,
        currency,
        status: existing.status,
        reused: true,
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
      idempotencyKey: `booking_${bookingId}_${kind.toLowerCase()}`,
    };

    const intent =
      kind === "DEPOSIT_HOLD"
        ? await this.provider.createDepositHold(input)
        : await this.provider.createPaymentIntent(input);

    const record = await this.prisma.paymentRecord.create({
      data: {
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
        metadata: {
          clientSecret: intent.clientSecret,
          renterId: booking.renterId,
          ownerId: booking.ownerId,
        } as Prisma.InputJsonValue,
      },
    });

    if (kind === "DEPOSIT_HOLD") {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: { depositPaymentIntentId: intent.id },
      });
    }

    await this.auditLog.create({
      actorId: renterId,
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
    };
  }

  private amountForKind(booking: Booking, kind: PaymentRecordKindLike): number {
    const map: Record<PaymentRecordKindLike, number | null> = {
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
    return Math.round(value * 100);
  }

  // ---- simulación de pago (solo provider mock) ----------------------------

  /**
   * Completa el pago de una reserva sin pasar por Stripe: crea los intents que
   * falten y los marca como cobrados/autorizados aplicando exactamente la misma
   * transición que el webhook real.
   *
   * Existe porque con PAYMENTS_PROVIDER=mock nadie envía el webhook, y sin él la
   * reserva se queda en PENDING para siempre: el dueño nunca puede marcarla
   * lista para retiro y el circuito entre los dos usuarios queda cortado.
   * Con el provider Stripe está deshabilitado (403): ahí manda el webhook.
   */
  async simulatePaymentSuccess(
    renterId: string,
    bookingId: string,
    kind?: PaymentRecordKindLike,
  ) {
    this.assertMockProvider();
    const kinds: PaymentRecordKindLike[] = kind
      ? [kind]
      : ["SENA", "BALANCE", "DEPOSIT_HOLD"];

    for (const current of kinds) {
      // El intent de saldo exige que la seña ya esté paga, así que el orden del
      // array importa: cada vuelta ve el estado que dejó la anterior.
      const intent =
        current === "BALANCE"
          ? await this.createBalanceIntent(renterId, bookingId)
          : await this.createChargeIntent(renterId, bookingId, current);

      if (current === "DEPOSIT_HOLD") {
        await this.onHoldAuthorized(intent.paymentIntentId);
      } else {
        await this.onIntentSucceeded(
          intent.paymentIntentId,
          `ch_mock_${intent.paymentIntentId}`,
        );
      }
    }

    return this.getStatus(renterId, bookingId);
  }

  /** Contracara de simulatePaymentSuccess: deja el cobro pendiente en FAILED. */
  async simulatePaymentFailure(
    renterId: string,
    bookingId: string,
    kind: PaymentRecordKindLike = "SENA",
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
        status: { notIn: [PaymentRecordStatus.FAILED] },
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
      throw new ForbiddenException(
        "La simulación de pagos solo está disponible con PAYMENTS_PROVIDER=mock",
      );
    }
  }

  // ---- status -------------------------------------------------------------

  async getStatus(userId: string, bookingId: string) {
    const booking = await this.findBookingForParticipant(userId, bookingId);
    const records = await this.prisma.paymentRecord.findMany({
      where: { bookingId },
      orderBy: { createdAt: "asc" },
    });
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
      paidAt: booking.paidAt,
      refundedAt: booking.refundedAt,
      records,
    };
  }

  // ---- webhook ------------------------------------------------------------

  async handleWebhook(rawBody: Buffer, signature: string | undefined) {
    let event;
    try {
      event = this.provider.constructWebhookEvent(rawBody, signature);
    } catch {
      throw new BadRequestException("Invalid Stripe webhook signature");
    }

    const already = await this.prisma.stripeEvent.findUnique({
      where: { eventId: event.id },
    });
    if (already?.processedAt) {
      return { received: true, duplicate: true };
    }
    if (!already) {
      await this.prisma.stripeEvent.create({
        data: {
          eventId: event.id,
          type: event.type,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    }

    await this.dispatchEvent(event.type, event.data.object);

    await this.prisma.stripeEvent.update({
      where: { eventId: event.id },
      data: { processedAt: new Date() },
    });

    return { received: true, duplicate: false };
  }

  private async dispatchEvent(
    type: string,
    object: Record<string, unknown>,
  ): Promise<void> {
    const paymentIntentId = object.id as string | undefined;
    if (!paymentIntentId) return;

    if (type === "payment_intent.succeeded") {
      await this.onIntentSucceeded(
        paymentIntentId,
        object.latest_charge as string | undefined,
      );
    } else if (type === "payment_intent.amount_capturable_updated") {
      await this.onHoldAuthorized(paymentIntentId);
    } else if (type === "payment_intent.payment_failed") {
      await this.onIntentFailed(paymentIntentId);
    }
  }

  private async onIntentSucceeded(piId: string, chargeId?: string) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record?.bookingId) return;
    const bookingId = record.bookingId;

    // The record's capture and the booking's payment status must move together.
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentRecord.update({
        where: { id: record.id },
        data: {
          status: PaymentRecordStatus.CAPTURED,
          stripeChargeId: chargeId,
          paidAt: new Date(),
        },
      });

      if (record.kind === PaymentRecordKind.SENA) {
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
    });

    await this.auditLog.create({
      action: "payment.intent.succeeded",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { paymentIntentId: piId, kind: record.kind },
    });
  }

  private async onHoldAuthorized(piId: string) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record) return;
    await this.prisma.paymentRecord.update({
      where: { id: record.id },
      data: { status: PaymentRecordStatus.AUTHORIZED },
    });
  }

  private async onIntentFailed(piId: string) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record?.bookingId) return;
    const bookingId = record.bookingId;
    const isCharge =
      record.kind === PaymentRecordKind.SENA ||
      record.kind === PaymentRecordKind.BALANCE;

    await this.prisma.$transaction(async (tx) => {
      await tx.paymentRecord.update({
        where: { id: record.id },
        data: { status: PaymentRecordStatus.FAILED },
      });
      if (isCharge) {
        await tx.booking.update({
          where: { id: bookingId },
          data: { paymentStatus: PaymentStatus.FAILED },
        });
      }
    });
  }

  // ---- pickup gate --------------------------------------------------------

  async assertReadyForPickup(bookingId: string): Promise<void> {
    const booking = await this.findBooking(bookingId);
    if (booking.paymentStatus !== PaymentStatus.FULLY_PAID) {
      throw new BadRequestException(
        "Full payment (seña + balance) is required before pickup",
      );
    }
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (!hold) {
      throw new BadRequestException(
        "The security deposit hold must be authorized before pickup",
      );
    }
  }

  // ---- settlement on return (release deposit + payout to owner) ------------

  async settleOnReturn(actorId: string, bookingId: string) {
    const booking = await this.findBookingWithUsers(bookingId);

    // Release the (clean-return) deposit hold if still authorized.
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (hold?.stripePaymentIntentId) {
      await this.provider.releaseHold({
        paymentIntentId: hold.stripePaymentIntentId,
        idempotencyKey: `booking_${bookingId}_deposit_release`,
      });
      await this.prisma.paymentRecord.update({
        where: { id: hold.id },
        data: { status: PaymentRecordStatus.RELEASED },
      });
    }

    // Transfer the owner payout to their connected account.
    const accountId = await this.ensureOwnerAccount(booking.owner);
    const amountMinor = Math.round((booking.ownerPayoutSnapshot ?? 0) * 100);
    if (amountMinor > 0) {
      const transfer = await this.provider.transferToOwner({
        amountMinor,
        currency: booking.currency,
        destination: accountId,
        transferGroup: booking.transferGroup,
        metadata: { bookingId },
        idempotencyKey: `booking_${bookingId}_owner_transfer`,
      });

      await this.prisma.$transaction([
        this.prisma.paymentRecord.create({
          data: {
            bookingId,
            userId: booking.ownerId,
            kind: PaymentRecordKind.OWNER_TRANSFER,
            status: PaymentRecordStatus.PAID,
            provider: this.provider.name,
            providerId: transfer.id,
            stripeTransferId: transfer.id,
            amount: amountMinor / 100,
            amountMinor,
            currency: booking.currency,
            paidAt: new Date(),
          },
        }),
        this.prisma.booking.update({
          where: { id: bookingId },
          data: { ownerTransferId: transfer.id },
        }),
      ]);
    }

    await this.auditLog.create({
      actorId,
      targetUserId: booking.ownerId,
      action: "payment.settled",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { ownerPayoutMinor: amountMinor },
    });
  }

  // ---- refund on cancel ---------------------------------------------------

  async refundOnCancel(actorId: string, bookingId: string) {
    const booking = await this.findBooking(bookingId);
    const charged = await this.prisma.paymentRecord.findMany({
      where: {
        bookingId,
        kind: { in: [PaymentRecordKind.SENA, PaymentRecordKind.BALANCE] },
        status: { in: PAID_RECORD_STATUSES },
      },
    });

    for (const record of charged) {
      if (!record.stripePaymentIntentId) continue;
      const refund = await this.provider.refund({
        paymentIntentId: record.stripePaymentIntentId,
        amountMinor: record.amountMinor ?? undefined,
        idempotencyKey: `booking_${bookingId}_${record.kind}_refund`,
      });
      await this.prisma.$transaction([
        this.prisma.paymentRecord.update({
          where: { id: record.id },
          data: {
            status: PaymentRecordStatus.REFUNDED,
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
            amount: (record.amountMinor ?? 0) / 100,
            amountMinor: record.amountMinor,
            currency: record.currency,
            refundedAt: new Date(),
          },
        }),
      ]);
    }

    // Release any authorized deposit hold.
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (hold?.stripePaymentIntentId) {
      await this.provider.releaseHold({
        paymentIntentId: hold.stripePaymentIntentId,
        idempotencyKey: `booking_${bookingId}_deposit_release`,
      });
      await this.prisma.paymentRecord.update({
        where: { id: hold.id },
        data: { status: PaymentRecordStatus.RELEASED },
      });
    }

    if (charged.length > 0) {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: {
          paymentStatus: PaymentStatus.REFUNDED,
          refundedAt: new Date(),
        },
      });
    }

    await this.auditLog.create({
      actorId,
      targetUserId: booking.ownerId,
      action: "payment.refunded",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { refunded: charged.length },
    });
  }

  // ---- connect onboarding (owner) -----------------------------------------

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

  // ---- helpers ------------------------------------------------------------

  private async ensureRenterCustomer(renter: User): Promise<string> {
    if (renter.stripeCustomerId) return renter.stripeCustomerId;
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
    if (owner.stripeAccountId) return owner.stripeAccountId;
    const account = await this.provider.createConnectedAccount({
      userId: owner.id,
      email: owner.email,
    });
    await this.prisma.user.update({
      where: { id: owner.id },
      data: {
        stripeAccountId: account.accountId,
        stripeAccountStatus: StripeAccountStatus.ENABLED,
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
      include: { owner: true, renter: true },
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
