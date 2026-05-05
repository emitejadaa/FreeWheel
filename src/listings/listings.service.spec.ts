import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ListingStatus } from '@prisma/client';
import { ListingsService } from './listings.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ListingsService', () => {
  let service: ListingsService;
  let prisma: {
    listing: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    vehicle: {
      findUnique: jest.Mock;
    };
  };

  const vehicle = {
    id: 'vehicle-1',
    ownerId: 'owner-1',
    brand: 'Toyota',
    model: 'Corolla',
    year: 2020,
    plate: 'AB123CD',
    color: 'Gray',
    seats: 5,
    transmission: null,
    fuelType: null,
    drivetrain: null,
    bluetooth: null,
    rearCamera: null,
    parkingSensors: null,
    fuelConsumptionLitersPer100Km: null,
    doors: null,
    trunkCapacityLiters: null,
    widthMm: null,
    lengthMm: null,
    heightMm: null,
    weightKg: null,
    observations: null,
    createdAt: new Date('2026-05-05T00:00:00.000Z'),
    updatedAt: new Date('2026-05-05T00:00:00.000Z'),
  };

  const listing = {
    id: 'listing-1',
    vehicleId: vehicle.id,
    ownerId: 'owner-1',
    title: 'Toyota Corolla en excelente estado',
    description: 'Auto comodo para ciudad y ruta.',
    pricePerDay: 45000,
    locationText: 'Palermo, CABA',
    latitude: null,
    longitude: null,
    deliveryLatitude: null,
    deliveryLongitude: null,
    deliveryRadiusKm: null,
    status: ListingStatus.ACTIVE,
    createdAt: new Date('2026-05-05T00:00:00.000Z'),
    updatedAt: new Date('2026-05-05T00:00:00.000Z'),
    vehicle,
  };

  beforeEach(async () => {
    prisma = {
      listing: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      vehicle: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();

    service = module.get<ListingsService>(ListingsService);
  });

  it('hides ownerId and vehicle plate in public listing lists', async () => {
    prisma.listing.findMany.mockResolvedValue([listing]);

    const result = await service.findActive();

    expect(result[0]).not.toHaveProperty('ownerId');
    expect(result[0].vehicle).not.toHaveProperty('ownerId');
    expect(result[0].vehicle).not.toHaveProperty('plate');
  });

  it('requires vehicle ownership when creating listings', async () => {
    prisma.vehicle.findUnique.mockResolvedValue({
      ...vehicle,
      ownerId: 'other-user',
    });

    await expect(
      service.create('owner-1', {
        vehicleId: vehicle.id,
        title: listing.title,
        description: listing.description,
        pricePerDay: listing.pricePerDay,
        locationText: listing.locationText,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not expose inactive listings publicly by id', async () => {
    prisma.listing.findUnique.mockResolvedValue({
      ...listing,
      status: ListingStatus.PAUSED,
    });

    await expect(service.findOne(listing.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
