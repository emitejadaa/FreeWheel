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
import { PaymentsService } from "../payments/payments.service";
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
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    await this.payments.createMockIntentForAcceptedBooking(updated, ownerId);

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: "booking.accepted",
      entityType: "Booking",
      entityId: id,
      metadata: { status: BookingStatus.ACCEPTED },
    });

    this.logger.log(`Booking ${id} accepted by owner ${ownerId}`);

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

    if (booking.paymentStatus === PaymentStatus.PAID) {
      await this.payments.refundMockPayment(userId, id);
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

    if (booking.paymentStatus !== PaymentStatus.PAID) {
      throw new BadRequestException("Payment must be confirmed before pickup");
    }

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

    await this.payments.releaseMockPayment(renterId, id);

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
}
