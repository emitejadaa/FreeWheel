import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  BookingStatus,
  PaymentRecordStatus,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import { AuditLogService } from "../common/services/audit-log.service";
import { PrismaService } from "../prisma/prisma.service";
import { MockWebhookEventType } from "./dto/mock-webhook.dto";
import { MockPaymentsProvider } from "./providers/mock-payments.provider";

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: MockPaymentsProvider,
    private readonly auditLog: AuditLogService,
  ) {}

  async createMockIntent(userId: string, bookingId: string) {
    const booking = await this.findBookingForParticipant(userId, bookingId);

    if (booking.renterId !== userId) {
      throw new ForbiddenException("Only the renter can start payment");
    }

    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException("Only accepted bookings can start payment");
    }

    return this.createMockIntentForAcceptedBooking(booking, userId);
  }

  async createMockIntentForAcceptedBooking(
    booking: {
      id: string;
      renterId: string;
      ownerId: string;
      status: BookingStatus;
      totalPriceSnapshot: number;
      currency: string;
    },
    actorId?: string,
  ) {
    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException("Only accepted bookings can start payment");
    }

    const existing = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId: booking.id,
        provider: this.provider.name,
        status: { in: [PaymentRecordStatus.PENDING, PaymentRecordStatus.PAID] },
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      return existing;
    }

    const intent = await this.provider.createIntent({
      bookingId: booking.id,
      amount: booking.totalPriceSnapshot,
      currency: booking.currency,
      metadata: {
        renterId: booking.renterId,
        ownerId: booking.ownerId,
      },
    });

    const paymentRecord = await this.prisma.paymentRecord.create({
      data: {
        bookingId: booking.id,
        userId: booking.renterId,
        status: PaymentRecordStatus.PENDING,
        provider: this.provider.name,
        providerId: intent.providerId,
        amount: intent.amount,
        currency: intent.currency,
        metadata: intent.metadata as Prisma.InputJsonValue,
      },
    });

    await this.prisma.booking.update({
      where: { id: booking.id },
      data: {
        paymentStatus: PaymentStatus.PENDING,
        paymentProvider: this.provider.name,
        providerPaymentId: intent.providerId,
      },
    });

    await this.auditLog.create({
      actorId,
      targetUserId: booking.ownerId,
      action: "payment.mock.created",
      entityType: "Booking",
      entityId: booking.id,
      metadata: { providerId: intent.providerId },
    });

    return paymentRecord;
  }

  async getBookingPaymentStatus(userId: string, bookingId: string) {
    const booking = await this.findBookingForParticipant(userId, bookingId);
    const records = await this.prisma.paymentRecord.findMany({
      where: { bookingId },
      orderBy: { createdAt: "desc" },
    });

    return {
      bookingId,
      paymentStatus: booking.paymentStatus,
      provider: booking.paymentProvider,
      providerPaymentId: booking.providerPaymentId,
      paidAt: booking.paidAt,
      refundedAt: booking.refundedAt,
      records,
    };
  }

  confirmMockPayment(actorId: string | undefined, bookingId: string) {
    return this.completeMockPayment(bookingId, {
      status: PaymentRecordStatus.PAID,
      paymentStatus: PaymentStatus.PAID,
      auditAction: "payment.mock.confirmed",
      actorId,
      dateField: "paidAt",
    });
  }

  failMockPayment(actorId: string | undefined, bookingId: string) {
    return this.completeMockPayment(bookingId, {
      status: PaymentRecordStatus.FAILED,
      paymentStatus: PaymentStatus.FAILED,
      auditAction: "payment.mock.failed",
      actorId,
    });
  }

  refundMockPayment(actorId: string | undefined, bookingId: string) {
    return this.completeMockPayment(bookingId, {
      status: PaymentRecordStatus.REFUNDED,
      paymentStatus: PaymentStatus.REFUNDED,
      auditAction: "payment.mock.refunded",
      actorId,
      dateField: "refundedAt",
    });
  }

  releaseMockPayment(actorId: string | undefined, bookingId: string) {
    return this.appendMockPaymentEvent(bookingId, {
      status: PaymentRecordStatus.PAID,
      auditAction: "payment.mock.released",
      actorId,
      metadata: { released: true, releasedAt: new Date().toISOString() },
    });
  }

  async handleMockWebhook(input: {
    bookingId: string;
    type: MockWebhookEventType;
    providerId?: string;
  }) {
    if (input.type === MockWebhookEventType.CONFIRMED) {
      return this.confirmMockPayment(undefined, input.bookingId);
    }
    if (input.type === MockWebhookEventType.FAILED) {
      return this.failMockPayment(undefined, input.bookingId);
    }
    return this.refundMockPayment(undefined, input.bookingId);
  }

  private async completeMockPayment(
    bookingId: string,
    input: {
      status: PaymentRecordStatus;
      paymentStatus: PaymentStatus;
      auditAction: string;
      actorId?: string;
      dateField?: "paidAt" | "refundedAt";
    },
  ) {
    const booking = input.actorId
      ? await this.findBookingForParticipant(input.actorId, bookingId)
      : await this.findBooking(bookingId);
    const record = await this.findLatestMockRecord(bookingId);
    const now = new Date();

    const updatedRecord = await this.prisma.paymentRecord.update({
      where: { id: record.id },
      data: {
        status: input.status,
        ...(input.dateField ? { [input.dateField]: now } : {}),
        metadata: {
          ...(record.metadata as Record<string, unknown> | null),
          mockStatus: input.status,
        },
      },
    });

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        paymentStatus: input.paymentStatus,
        ...(input.dateField ? { [input.dateField]: now } : {}),
      },
    });

    await this.auditLog.create({
      actorId: input.actorId,
      targetUserId: booking.ownerId,
      action: input.auditAction,
      entityType: "Booking",
      entityId: bookingId,
      metadata: { paymentRecordId: updatedRecord.id },
    });

    return updatedRecord;
  }

  private async appendMockPaymentEvent(
    bookingId: string,
    input: {
      status: PaymentRecordStatus;
      auditAction: string;
      actorId?: string;
      metadata: Record<string, unknown>;
    },
  ) {
    const booking = input.actorId
      ? await this.findBookingForParticipant(input.actorId, bookingId)
      : await this.findBooking(bookingId);
    const paidRecord = await this.findLatestMockRecord(bookingId);

    if (paidRecord.status !== PaymentRecordStatus.PAID) {
      throw new BadRequestException("Only paid bookings can be released");
    }

    const record = await this.prisma.paymentRecord.create({
      data: {
        bookingId,
        userId: booking.renterId,
        status: input.status,
        provider: this.provider.name,
        providerId: paidRecord.providerId,
        amount: paidRecord.amount,
        currency: paidRecord.currency,
        metadata: input.metadata as Prisma.InputJsonValue,
        paidAt: new Date(),
      },
    });

    await this.auditLog.create({
      actorId: input.actorId,
      targetUserId: booking.ownerId,
      action: input.auditAction,
      entityType: "Booking",
      entityId: bookingId,
      metadata: { paymentRecordId: record.id },
    });

    return record;
  }

  private async findBookingForParticipant(userId: string, bookingId: string) {
    const booking = await this.findBooking(bookingId);

    if (booking.ownerId !== userId && booking.renterId !== userId) {
      throw new ForbiddenException("You cannot access this payment");
    }

    return booking;
  }

  private async findBooking(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException("Booking not found");
    }

    return booking;
  }

  private async findLatestMockRecord(bookingId: string) {
    const record = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        provider: this.provider.name,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!record) {
      throw new BadRequestException("Mock payment intent was not created");
    }

    return record;
  }
}
