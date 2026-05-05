import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { VehiclesService } from './vehicles.service';
import { PrismaService } from '../prisma/prisma.service';

describe('VehiclesService', () => {
  let service: VehiclesService;
  let prisma: {
    vehicle: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    listing: {
      count: jest.Mock;
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

  beforeEach(async () => {
    prisma = {
      vehicle: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      listing: {
        count: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VehiclesService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();

    service = module.get<VehiclesService>(VehiclesService);
  });

  it('hides ownerId and plate in public vehicle responses', async () => {
    prisma.vehicle.findUnique.mockResolvedValue(vehicle);

    const result = await service.findOne(vehicle.id);

    expect(result).not.toHaveProperty('ownerId');
    expect(result).not.toHaveProperty('plate');
    expect(result.brand).toBe('Toyota');
  });

  it('rejects updates from non-owners', async () => {
    prisma.vehicle.findUnique.mockResolvedValue(vehicle);

    await expect(
      service.update('other-user', vehicle.id, { color: 'Black' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks deleting vehicles that already have listings', async () => {
    prisma.vehicle.findUnique.mockResolvedValue(vehicle);
    prisma.listing.count.mockResolvedValue(1);

    await expect(
      service.remove(vehicle.ownerId, vehicle.id),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
