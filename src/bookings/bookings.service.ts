import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Booking, BookingStatus, ListingStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { AuditLogService } from '../common/services/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { CreateBookingDto } from './dto/create-booking.dto';

const blockingStatuses: BookingStatus[] = [
  BookingStatus.ACCEPTED,
  BookingStatus.READY_FOR_PICKUP,
  BookingStatus.IN_PROGRESS,
  BookingStatus.RETURN_PENDING,
];

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async create(renterId: string, data: CreateBookingDto) {
    this.assertDateRange(data.startDate, data.endDate);

    const listing = await this.prisma.listing.findUnique({
      where: { id: data.listingId },
      include: { vehicle: true },
    });

    if (!listing || listing.status !== ListingStatus.ACTIVE) {
      throw new BadRequestException('Listing is not available for booking');
    }

    if (listing.ownerId === renterId) {
      throw new ForbiddenException('You cannot book your own listing');
    }

    await this.assertNoOverlap(listing.id, data.startDate, data.endDate);

    const days = this.calculateDays(data.startDate, data.endDate);
    const totalPriceSnapshot = listing.pricePerDay * days;

    return this.prisma.booking.create({
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
      include: this.bookingInclude(),
    });
  }

  findMine(userId: string) {
    return this.prisma.booking.findMany({
      where: {
        OR: [{ renterId: userId }, { ownerId: userId }],
      },
      include: this.bookingInclude(),
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOneForParticipant(userId: string, id: string) {
    const booking = await this.findById(id);
    this.assertParticipant(booking, userId);

    return booking;
  }

  async accept(ownerId: string, id: string) {
    const booking = await this.findById(id);
    this.assertOwner(booking, ownerId);

    if (booking.status !== BookingStatus.REQUESTED) {
      throw new BadRequestException('Only requested bookings can be accepted');
    }

    await this.assertNoOverlap(
      booking.listingId,
      booking.startDate,
      booking.endDate,
      id,
    );

    const pickupToken = this.generateToken();
    const returnToken = this.generateToken();
    const updated = await this.prisma.booking.update({
      where: { id },
      data: {
        status: BookingStatus.ACCEPTED,
        pickupTokenHash: await bcrypt.hash(pickupToken, 10),
        returnTokenHash: await bcrypt.hash(returnToken, 10),
        pickupTokenPreview: pickupToken,
        returnTokenPreview: returnToken,
      },
      include: this.bookingInclude(),
    });

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: 'booking.accept',
      entityType: 'Booking',
      entityId: id,
      metadata: { status: BookingStatus.ACCEPTED },
    });

    return {
      ...updated,
      pickupQrToken: pickupToken,
      returnQrToken: returnToken,
    };
  }

  async reject(ownerId: string, id: string) {
    const booking = await this.findById(id);
    this.assertOwner(booking, ownerId);

    if (booking.status !== BookingStatus.REQUESTED) {
      throw new BadRequestException('Only requested bookings can be rejected');
    }

    return this.prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.REJECTED },
      include: this.bookingInclude(),
    });
  }

  async cancel(userId: string, id: string, data: CancelBookingDto) {
    const booking = await this.findById(id);
    this.assertParticipant(booking, userId);

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
        'Booking cannot be cancelled in this status',
      );
    }

    const status =
      userId === booking.renterId
        ? BookingStatus.CANCELLED_BY_RENTER
        : BookingStatus.CANCELLED_BY_OWNER;

    return this.prisma.booking.update({
      where: { id },
      data: {
        status,
        cancelledAt: new Date(),
        cancellationReason: data.reason,
      },
      include: this.bookingInclude(),
    });
  }

  async readyForPickup(ownerId: string, id: string) {
    const booking = await this.findById(id);
    this.assertOwner(booking, ownerId);

    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(
        'Only accepted bookings can be marked ready',
      );
    }

    return this.prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.READY_FOR_PICKUP },
      include: this.bookingInclude(),
    });
  }

  async getTokens(userId: string, id: string) {
    const booking = await this.findById(id);
    this.assertParticipant(booking, userId);

    return {
      pickupQrToken:
        userId === booking.renterId &&
        (
          [
            BookingStatus.ACCEPTED,
            BookingStatus.READY_FOR_PICKUP,
          ] as BookingStatus[]
        ).includes(booking.status)
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
    this.assertOwner(booking, ownerId);

    if (
      !(
        [
          BookingStatus.ACCEPTED,
          BookingStatus.READY_FOR_PICKUP,
        ] as BookingStatus[]
      ).includes(booking.status)
    ) {
      throw new BadRequestException(
        'Pickup cannot be confirmed in this status',
      );
    }

    if (!booking.pickupTokenHash) {
      throw new BadRequestException('Pickup token was not generated');
    }

    if (!(await bcrypt.compare(token, booking.pickupTokenHash))) {
      throw new ForbiddenException('Invalid pickup token');
    }

    return this.prisma.booking.update({
      where: { id },
      data: {
        status: BookingStatus.IN_PROGRESS,
        pickupConfirmedAt: new Date(),
        pickupTokenHash: null,
        pickupTokenPreview: null,
      },
      include: this.bookingInclude(),
    });
  }

  async confirmReturn(renterId: string, id: string, token: string) {
    const booking = await this.findById(id);

    if (booking.renterId !== renterId) {
      throw new ForbiddenException('Only the renter can confirm return');
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
        'Return cannot be confirmed in this status',
      );
    }

    if (!booking.returnTokenHash) {
      throw new BadRequestException('Return token was not generated');
    }

    if (!(await bcrypt.compare(token, booking.returnTokenHash))) {
      throw new ForbiddenException('Invalid return token');
    }

    return this.prisma.booking.update({
      where: { id },
      data: {
        status: BookingStatus.COMPLETED,
        returnConfirmedAt: new Date(),
        returnTokenHash: null,
        returnTokenPreview: null,
      },
      include: this.bookingInclude(),
    });
  }

  private async findById(id: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: this.bookingInclude(),
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    return booking;
  }

  private assertDateRange(startDate: Date, endDate: Date) {
    if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
      throw new BadRequestException('Invalid startDate');
    }

    if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid endDate');
    }

    if (startDate <= new Date()) {
      throw new BadRequestException('startDate must be in the future');
    }

    if (endDate <= startDate) {
      throw new BadRequestException('endDate must be after startDate');
    }
  }

  private async assertNoOverlap(
    listingId: string,
    startDate: Date,
    endDate: Date,
    excludeBookingId?: string,
  ) {
    const overlapping = await this.prisma.booking.findFirst({
      where: {
        listingId,
        status: { in: blockingStatuses },
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
        startDate: { lt: endDate },
        endDate: { gt: startDate },
      },
    });

    if (overlapping) {
      throw new BadRequestException(
        'Booking dates overlap with another booking',
      );
    }
  }

  private calculateDays(startDate: Date, endDate: Date) {
    const milliseconds = endDate.getTime() - startDate.getTime();
    return Math.ceil(milliseconds / (1000 * 60 * 60 * 24));
  }

  private assertParticipant(booking: Booking, userId: string) {
    if (booking.ownerId !== userId && booking.renterId !== userId) {
      throw new ForbiddenException('You cannot access this booking');
    }
  }

  private assertOwner(booking: Booking, userId: string) {
    if (booking.ownerId !== userId) {
      throw new ForbiddenException('Only the owner can perform this action');
    }
  }

  private generateToken() {
    return randomBytes(24).toString('hex');
  }

  private bookingInclude() {
    return {
      listing: true,
      vehicle: true,
      owner: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          displayName: true,
        },
      },
      renter: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          displayName: true,
        },
      },
    };
  }
}
