import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BookingStatus, ListingStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuditLogService } from '../common/services/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { BookingsService } from './bookings.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));

describe('BookingsService', () => {
  let service: BookingsService;
  let prisma: {
    listing: { findUnique: jest.Mock };
    booking: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
  };

  const listing = {
    id: 'listing-1',
    vehicleId: 'vehicle-1',
    ownerId: 'owner-1',
    status: ListingStatus.ACTIVE,
    pricePerDay: 100,
    vehicle: { id: 'vehicle-1' },
  };

  const booking = {
    id: 'booking-1',
    listingId: 'listing-1',
    vehicleId: 'vehicle-1',
    ownerId: 'owner-1',
    renterId: 'renter-1',
    startDate: new Date('2099-01-01T00:00:00.000Z'),
    endDate: new Date('2099-01-03T00:00:00.000Z'),
    status: BookingStatus.REQUESTED,
    pickupTokenHash: 'pickup-hash',
    returnTokenHash: 'return-hash',
  };

  beforeEach(async () => {
    prisma = {
      listing: { findUnique: jest.fn() },
      booking: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: AuditLogService,
          useValue: { create: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(BookingsService);
    (bcrypt.hash as jest.Mock).mockResolvedValue('token-hash');
  });

  it('creates a booking for an active listing', async () => {
    prisma.listing.findUnique.mockResolvedValue(listing);
    prisma.booking.findFirst.mockResolvedValue(null);
    prisma.booking.create.mockResolvedValue(booking);

    const result = await service.create('renter-1', {
      listingId: listing.id,
      startDate: booking.startDate,
      endDate: booking.endDate,
    });

    expect(result).toBe(booking);
    expect(prisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: listing.ownerId,
          renterId: 'renter-1',
          totalPriceSnapshot: 200,
        }),
      }),
    );
  });

  it('rejects booking your own listing', async () => {
    prisma.listing.findUnique.mockResolvedValue(listing);

    await expect(
      service.create('owner-1', {
        listingId: listing.id,
        startDate: booking.startDate,
        endDate: booking.endDate,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects overlapping bookings', async () => {
    prisma.listing.findUnique.mockResolvedValue(listing);
    prisma.booking.findFirst.mockResolvedValue(booking);

    await expect(
      service.create('renter-1', {
        listingId: listing.id,
        startDate: booking.startDate,
        endDate: booking.endDate,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts and generates QR tokens', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking);
    prisma.booking.findFirst.mockResolvedValue(null);
    prisma.booking.update.mockResolvedValue({
      ...booking,
      status: BookingStatus.ACCEPTED,
    });

    const result = await service.accept('owner-1', booking.id);

    expect(result.pickupQrToken).toBeDefined();
    expect(result.returnQrToken).toBeDefined();
  });

  it('confirms pickup with correct token', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      ...booking,
      status: BookingStatus.READY_FOR_PICKUP,
    });
    prisma.booking.update.mockResolvedValue({
      ...booking,
      status: BookingStatus.IN_PROGRESS,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const result = await service.confirmPickup('owner-1', booking.id, 'token');

    expect(result.status).toBe(BookingStatus.IN_PROGRESS);
  });

  it('rejects wrong return token', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      ...booking,
      status: BookingStatus.IN_PROGRESS,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(
      service.confirmReturn('renter-1', booking.id, 'bad-token'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
