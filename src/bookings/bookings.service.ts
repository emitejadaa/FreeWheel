import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import {
  Booking,
  BookingStatus,
  ListingStatus,
  PaymentStatus,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { AvailabilityService } from "../availability/availability.service";
import { AuditLogService } from "../common/services/audit-log.service";
import { ContractsService } from "../contracts/contracts.service";
import { EmailService } from "../email/email.service";
import { PaymentsService } from "../payments/payments.service";
import { PricingService } from "../payments/pricing.service";
import { PrismaService } from "../prisma/prisma.service";
import { assertFound } from "../common/utils/entity.util";
import {
  assertOwner,
  assertParticipant,
} from "../common/utils/authorization.util";
import { generateOpaqueToken } from "../common/utils/verification-code.util";
import { BOOKING_PARTICIPANT_INCLUDE } from "../common/constants/prisma-select";
import { CancelBookingDto } from "./dto/cancel-booking.dto";
import { CreateBookingDto } from "./dto/create-booking.dto";

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly availability: AvailabilityService,
    private readonly payments: PaymentsService,
    private readonly pricing: PricingService,
    private readonly contracts: ContractsService,
    private readonly email: EmailService,
  ) {}

  async create(renterId: string, data: CreateBookingDto) {
    this.availability.assertDateRange(data.startDate, data.endDate);

    const listing = await this.prisma.listing.findUnique({
      where: { id: data.listingId },
      include: { vehicle: true },
    });

    if (!listing || listing.status !== ListingStatus.ACTIVE) {
      throw new BadRequestException("Listing is not available for booking");
    }

    if (listing.ownerId === renterId) {
      throw new ForbiddenException("You cannot book your own listing");
    }

    await this.availability.assertListingIsBookable(
      listing.id,
      data.startDate,
      data.endDate,
    );

    const days = this.availability.calculateDays(data.startDate, data.endDate);
    const totalPriceSnapshot = listing.pricePerDay * days;

    const created = await this.prisma.booking.create({
      data: {
        listingId: listing.id,
        vehicleId: listing.vehicleId,
        ownerId: listing.ownerId,
        renterId,
        startDate: data.startDate,
        endDate: data.endDate,
        pricePerDaySnapshot: listing.pricePerDay,
        totalPriceSnapshot,
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    await this.auditLog.create({
      actorId: renterId,
      targetUserId: listing.ownerId,
      action: "booking.created",
      entityType: "Booking",
      entityId: created.id,
      metadata: { status: BookingStatus.REQUESTED },
    });

    this.logger.log(
      `Booking ${created.id} requested by renter ${renterId} on listing ${listing.id}`,
    );

    await this.safeNotify(() => {
      if (!created.owner?.email) return;
      return this.email.sendBookingRequestedToOwner(created.owner.email, {
        ownerName: this.personName(created.owner),
        renterName: this.personName(created.renter),
        vehicleLabel: this.vehicleLabel(created),
        startDate: created.startDate,
        endDate: created.endDate,
        totalPrice: created.totalPriceSnapshot,
        currency: created.currency,
      });
    });

    return created;
  }

  findMine(userId: string) {
    return this.prisma.booking.findMany({
      where: {
        OR: [{ renterId: userId }, { ownerId: userId }],
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
  }

  async findOneForParticipant(userId: string, id: string) {
    const booking = await this.findById(id);
    this.assertBookingParticipant(booking, userId);

    return booking;
  }

  async accept(ownerId: string, id: string) {
    const booking = await this.findById(id);
    this.assertBookingOwner(booking, ownerId);

    if (booking.status !== BookingStatus.REQUESTED) {
      throw new BadRequestException("Only requested bookings can be accepted");
    }

    await this.availability.assertListingIsBookable(
      booking.listingId,
      booking.startDate,
      booking.endDate,
      id,
    );

    const days = this.availability.calculateDays(
      booking.startDate,
      booking.endDate,
    );
    const pricing = this.pricing.computeBooking({
      pricePerDay: booking.pricePerDaySnapshot,
      days,
    });

    const pickupToken = generateOpaqueToken(24);
    const returnToken = generateOpaqueToken(24);
    const updated = await this.prisma.booking.update({
      where: { id },
      data: {
        status: BookingStatus.ACCEPTED,
        paymentStatus: PaymentStatus.PENDING,
        pickupTokenHash: await bcrypt.hash(pickupToken, 10),
        returnTokenHash: await bcrypt.hash(returnToken, 10),
        pickupTokenPreview: pickupToken,
        returnTokenPreview: returnToken,
        currency: pricing.currency,
        totalPriceSnapshot: pricing.total,
        rentalSubtotalSnapshot: pricing.rentalSubtotal,
        insuranceSnapshot: pricing.insurance,
        platformFeeSnapshot: pricing.commission,
        senaAmountSnapshot: pricing.sena,
        balanceAmountSnapshot: pricing.balance,
        depositSnapshot: pricing.deposit,
        ownerPayoutSnapshot: pricing.ownerPayout,
        transferGroup: `booking_${id}`,
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    // Lock the digital contract (PDF rendered on demand from these snapshots).
    await this.contracts.createForBooking(id);

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: "booking.accepted",
      entityType: "Booking",
      entityId: id,
      metadata: { status: BookingStatus.ACCEPTED },
    });

    this.logger.log(`Booking ${id} accepted by owner ${ownerId}`);

    await this.safeNotify(() => {
      if (!updated.renter?.email) return;
      return this.email.sendBookingAcceptedToRenter(updated.renter.email, {
        renterName: this.personName(updated.renter),
        vehicleLabel: this.vehicleLabel(updated),
        startDate: updated.startDate,
        endDate: updated.endDate,
      });
    });

    return {
      ...updated,
      pickupQrToken: pickupToken,
      returnQrToken: returnToken,
    };
  }

  async reject(ownerId: string, id: string) {
    const booking = await this.findById(id);
    this.assertBookingOwner(booking, ownerId);

    if (booking.status !== BookingStatus.REQUESTED) {
      throw new BadRequestException("Only requested bookings can be rejected");
    }

    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.REJECTED },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: "booking.rejected",
      entityType: "Booking",
      entityId: id,
      metadata: { status: BookingStatus.REJECTED },
    });

    this.logger.log(`Booking ${id} rejected by owner ${ownerId}`);

    await this.safeNotify(() => {
      if (!updated.renter?.email) return;
      return this.email.sendBookingRejectedToRenter(updated.renter.email, {
        renterName: this.personName(updated.renter),
        vehicleLabel: this.vehicleLabel(updated),
        startDate: updated.startDate,
        endDate: updated.endDate,
      });
    });

    return updated;
  }

  async cancel(userId: string, id: string, data: CancelBookingDto) {
    const booking = await this.findById(id);
    this.assertBookingParticipant(booking, userId);

    if (
      !(
        [
          BookingStatus.REQUESTED,
          BookingStatus.ACCEPTED,
          BookingStatus.READY_FOR_PICKUP,
        ] as BookingStatus[]
      ).includes(booking.status)
    ) {
      throw new BadRequestException(
        "Booking cannot be cancelled in this status",
      );
    }

    const status =
      userId === booking.renterId
        ? BookingStatus.CANCELLED_BY_RENTER
        : BookingStatus.CANCELLED_BY_OWNER;

    const updated = await this.prisma.booking.update({
      where: { id },
      data: {
        status,
        cancelledAt: new Date(),
        cancellationReason: data.reason,
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    const refundable: PaymentStatus[] = [
      PaymentStatus.DEPOSIT_PAID,
      PaymentStatus.FULLY_PAID,
      PaymentStatus.PARTIALLY_REFUNDED,
    ];
    if (refundable.includes(booking.paymentStatus)) {
      await this.payments.refundOnCancel(userId, id);
    }

    await this.auditLog.create({
      actorId: userId,
      targetUserId:
        userId === booking.renterId ? booking.ownerId : booking.renterId,
      action: "booking.cancelled",
      entityType: "Booking",
      entityId: id,
      metadata: { status },
    });

    this.logger.log(`Booking ${id} cancelled by ${userId} (${status})`);

    return updated;
  }

  async readyForPickup(ownerId: string, id: string) {
    const booking = await this.findById(id);
    this.assertBookingOwner(booking, ownerId);

    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(
        "Only accepted bookings can be marked ready",
      );
    }

    // Requires seña + balance fully paid and the deposit hold authorized.
    await this.payments.assertReadyForPickup(id);

    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.READY_FOR_PICKUP },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: "booking.ready_for_pickup",
      entityType: "Booking",
      entityId: id,
      metadata: { status: BookingStatus.READY_FOR_PICKUP },
    });

    this.logger.log(
      `Booking ${id} marked ready for pickup by owner ${ownerId}`,
    );

    return updated;
  }

  async getTokens(userId: string, id: string) {
    const booking = await this.findById(id);
    this.assertBookingParticipant(booking, userId);

    return {
      // The renter sees the pickup QR only while the booking is ready for
      // pickup; the owner sees the return QR only once the rental is underway.
      pickupQrToken:
        userId === booking.renterId &&
        ([BookingStatus.READY_FOR_PICKUP] as BookingStatus[]).includes(
          booking.status,
        )
          ? booking.pickupTokenPreview
          : undefined,
      returnQrToken:
        userId === booking.ownerId &&
        (
          [
            BookingStatus.IN_PROGRESS,
            BookingStatus.RETURN_PENDING,
          ] as BookingStatus[]
        ).includes(booking.status)
          ? booking.returnTokenPreview
          : undefined,
    };
  }

  async confirmPickup(ownerId: string, id: string, token: string) {
    const booking = await this.findById(id);
    this.assertBookingOwner(booking, ownerId);

    if (
      !([BookingStatus.READY_FOR_PICKUP] as BookingStatus[]).includes(
        booking.status,
      )
    ) {
      throw new BadRequestException(
        "Pickup cannot be confirmed in this status",
      );
    }

    if (!booking.pickupTokenHash) {
      throw new BadRequestException("Pickup token was not generated");
    }

    if (!(await bcrypt.compare(token, booking.pickupTokenHash))) {
      throw new ForbiddenException("Invalid pickup token");
    }

    const updated = await this.prisma.booking.update({
      where: { id },
      data: {
        status: BookingStatus.IN_PROGRESS,
        pickupConfirmedAt: new Date(),
        pickupTokenHash: null,
        pickupTokenPreview: null,
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: "booking.pickup_confirmed",
      entityType: "Booking",
      entityId: id,
      metadata: { status: BookingStatus.IN_PROGRESS },
    });

    this.logger.log(`Booking ${id} pickup confirmed by owner ${ownerId}`);

    return updated;
  }

  async confirmReturn(renterId: string, id: string, token: string) {
    const booking = await this.findById(id);

    if (booking.renterId !== renterId) {
      throw new ForbiddenException("Only the renter can confirm return");
    }

    if (
      !(
        [
          BookingStatus.IN_PROGRESS,
          BookingStatus.RETURN_PENDING,
        ] as BookingStatus[]
      ).includes(booking.status)
    ) {
      throw new BadRequestException(
        "Return cannot be confirmed in this status",
      );
    }

    if (!booking.returnTokenHash) {
      throw new BadRequestException("Return token was not generated");
    }

    if (!(await bcrypt.compare(token, booking.returnTokenHash))) {
      throw new ForbiddenException("Invalid return token");
    }

    const updated = await this.prisma.booking.update({
      where: { id },
      data: {
        status: BookingStatus.COMPLETED,
        returnConfirmedAt: new Date(),
        returnTokenHash: null,
        returnTokenPreview: null,
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    // Release the deposit hold (clean return) and transfer the owner payout.
    await this.payments.settleOnReturn(renterId, id);

    await this.auditLog.create({
      actorId: renterId,
      targetUserId: booking.ownerId,
      action: "booking.return_confirmed",
      entityType: "Booking",
      entityId: id,
      metadata: { status: BookingStatus.COMPLETED },
    });

    this.logger.log(`Booking ${id} return confirmed by renter ${renterId}`);

    return updated;
  }

  private async findById(id: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });
    assertFound(booking, "Booking not found");

    return booking;
  }

  private assertBookingParticipant(booking: Booking, userId: string) {
    assertParticipant(
      booking.ownerId,
      booking.renterId,
      userId,
      "You cannot access this booking",
    );
  }

  private assertBookingOwner(booking: Booking, userId: string) {
    assertOwner(
      booking.ownerId,
      userId,
      "Only the owner can perform this action",
    );
  }

  private async safeNotify(fn: () => Promise<unknown> | void): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error enviando notificacion de reserva: ${message}`);
    }
  }

  private personName(person?: {
    displayName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
  }): string {
    if (!person) return "";
    return (
      person.displayName ||
      [person.firstName, person.lastName].filter(Boolean).join(" ") ||
      person.email ||
      ""
    );
  }

  private vehicleLabel(booking: {
    vehicle?: {
      brand?: string | null;
      model?: string | null;
      year?: number | null;
    } | null;
  }): string {
    const v = booking.vehicle;
    if (!v) return "el vehiculo";
    return (
      [v.brand, v.model, v.year].filter(Boolean).join(" ") || "el vehiculo"
    );
  }
}
