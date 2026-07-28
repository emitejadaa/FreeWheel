import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { BookingStatus, ListingStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateAvailabilityBlockDto } from "./dto/create-availability-block.dto";

export const blockingBookingStatuses: BookingStatus[] = [
  BookingStatus.ACCEPTED,
  BookingStatus.READY_FOR_PICKUP,
  BookingStatus.IN_PROGRESS,
  BookingStatus.RETURN_PENDING,
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Fecha (UTC) como YYYY-MM-DD, sin la parte de hora. */
function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Medianoche UTC del día de una fecha. */
function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * Convierte rangos [startDate, endDate) en la lista de días ocupados que caen
 * dentro de la ventana consultada. El día de devolución (endDate) cuenta como
 * ocupado porque el auto todavía no volvió a estar libre esa jornada.
 */
function expandRangesToDays(
  ranges: { startDate: Date; endDate: Date }[],
  windowStart: Date,
  windowEnd: Date,
): string[] {
  const days = new Set<string>();
  const from = startOfUtcDay(windowStart).getTime();
  const to = startOfUtcDay(windowEnd).getTime();

  for (const range of ranges) {
    let cursor = Math.max(startOfUtcDay(range.startDate).getTime(), from);
    const last = Math.min(startOfUtcDay(range.endDate).getTime(), to);
    // Tope de seguridad: una ventana de consulta no debería superar el año.
    for (let guard = 0; cursor <= last && guard < 750; guard++) {
      days.add(toDayKey(new Date(cursor)));
      cursor += MS_PER_DAY;
    }
  }

  return [...days].sort();
}

@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async getListingAvailability(
    listingId: string,
    startDate: Date,
    endDate: Date,
  ) {
    this.assertDateRange(startDate, endDate, { allowPast: true });
    const listing = await this.findListing(listingId);
    const [bookings, manualBlocks] = await Promise.all([
      this.prisma.booking.findMany({
        where: this.overlappingBookingsWhere(listingId, startDate, endDate),
        select: {
          id: true,
          startDate: true,
          endDate: true,
          status: true,
        },
        orderBy: { startDate: "asc" },
      }),
      this.prisma.listingAvailabilityBlock.findMany({
        where: this.overlappingBlocksWhere(listingId, startDate, endDate),
        select: {
          id: true,
          startDate: true,
          endDate: true,
          reason: true,
        },
        orderBy: { startDate: "asc" },
      }),
    ]);

    return {
      listingId,
      vehicleId: listing.vehicleId,
      startDate,
      endDate,
      available:
        listing.status === ListingStatus.ACTIVE &&
        bookings.length === 0 &&
        manualBlocks.length === 0,
      listingStatus: listing.status,
      blockingBookings: bookings,
      manualBlocks,
      // Mismos rangos, ya expandidos día por día (YYYY-MM-DD): es lo que el
      // calendario del front necesita para pintar/bloquear fechas sin tener que
      // recalcular solapamientos en el navegador.
      unavailableDates: expandRangesToDays(
        [...bookings, ...manualBlocks],
        startDate,
        endDate,
      ),
    };
  }

  async createBlock(
    ownerId: string,
    listingId: string,
    data: CreateAvailabilityBlockDto,
  ) {
    this.assertDateRange(data.startDate, data.endDate);
    const listing = await this.findListing(listingId);
    this.assertListingOwner(listing.ownerId, ownerId);

    await this.assertNoManualBlockOverlap(
      listingId,
      data.startDate,
      data.endDate,
    );

    return this.prisma.listingAvailabilityBlock.create({
      data: {
        listingId,
        ownerId,
        startDate: data.startDate,
        endDate: data.endDate,
        reason: data.reason,
      },
      include: { listing: true },
    });
  }

  async listBlocks(ownerId: string, listingId: string) {
    const listing = await this.findListing(listingId);
    this.assertListingOwner(listing.ownerId, ownerId);

    return this.prisma.listingAvailabilityBlock.findMany({
      where: { listingId },
      orderBy: { startDate: "asc" },
    });
  }

  async deleteBlock(ownerId: string, listingId: string, blockId: string) {
    const listing = await this.findListing(listingId);
    this.assertListingOwner(listing.ownerId, ownerId);

    const block = await this.prisma.listingAvailabilityBlock.findUnique({
      where: { id: blockId },
    });

    if (!block || block.listingId !== listingId) {
      throw new NotFoundException("Availability block not found");
    }

    await this.prisma.listingAvailabilityBlock.delete({
      where: { id: blockId },
    });

    return { deleted: true, id: blockId };
  }

  async assertListingIsBookable(
    listingId: string,
    startDate: Date,
    endDate: Date,
    excludeBookingId?: string,
  ) {
    await this.assertNoBookingOverlap(
      listingId,
      startDate,
      endDate,
      excludeBookingId,
    );
    await this.assertNoManualBlockOverlap(listingId, startDate, endDate);
  }

  assertDateRange(
    startDate: Date,
    endDate: Date,
    options: { allowPast?: boolean } = {},
  ) {
    if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
      throw new BadRequestException("Invalid startDate");
    }

    if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestException("Invalid endDate");
    }

    if (!options.allowPast && startDate <= new Date()) {
      throw new BadRequestException("startDate must be in the future");
    }

    if (endDate <= startDate) {
      throw new BadRequestException("endDate must be after startDate");
    }
  }

  calculateDays(startDate: Date, endDate: Date) {
    const milliseconds = endDate.getTime() - startDate.getTime();
    return Math.ceil(milliseconds / (1000 * 60 * 60 * 24));
  }

  async assertNoManualBlockOverlap(
    listingId: string,
    startDate: Date,
    endDate: Date,
    excludeBlockId?: string,
  ) {
    const overlapping = await this.prisma.listingAvailabilityBlock.findFirst({
      where: {
        ...this.overlappingBlocksWhere(listingId, startDate, endDate),
        ...(excludeBlockId ? { id: { not: excludeBlockId } } : {}),
      },
    });

    if (overlapping) {
      throw new BadRequestException(
        "Dates overlap with a manual availability block",
      );
    }
  }

  private async assertNoBookingOverlap(
    listingId: string,
    startDate: Date,
    endDate: Date,
    excludeBookingId?: string,
  ) {
    const overlapping = await this.prisma.booking.findFirst({
      where: {
        ...this.overlappingBookingsWhere(listingId, startDate, endDate),
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      },
    });

    if (overlapping) {
      throw new BadRequestException(
        "Booking dates overlap with another active booking",
      );
    }
  }

  private overlappingBookingsWhere(
    listingId: string,
    startDate: Date,
    endDate: Date,
  ) {
    return {
      listingId,
      status: { in: blockingBookingStatuses },
      startDate: { lt: endDate },
      endDate: { gt: startDate },
    };
  }

  private overlappingBlocksWhere(
    listingId: string,
    startDate: Date,
    endDate: Date,
  ) {
    return {
      listingId,
      startDate: { lt: endDate },
      endDate: { gt: startDate },
    };
  }

  private async findListing(listingId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: { vehicle: true },
    });

    if (!listing) {
      throw new NotFoundException("Listing not found");
    }

    return listing;
  }

  private assertListingOwner(listingOwnerId: string, userId: string) {
    if (listingOwnerId !== userId) {
      throw new ForbiddenException("You cannot manage this listing");
    }
  }
}
