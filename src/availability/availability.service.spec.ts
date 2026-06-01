import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, ListingStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AvailabilityService } from "./availability.service";

describe("AvailabilityService", () => {
  let service: AvailabilityService;
  let prisma: {
    listing: { findUnique: jest.Mock };
    booking: { findMany: jest.Mock; findFirst: jest.Mock };
    listingAvailabilityBlock: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      delete: jest.Mock;
    };
  };

  const listing = {
    id: "listing-1",
    vehicleId: "vehicle-1",
    ownerId: "owner-1",
    status: ListingStatus.ACTIVE,
  };

  const startDate = new Date("2099-01-01T00:00:00.000Z");
  const endDate = new Date("2099-01-03T00:00:00.000Z");

  beforeEach(async () => {
    prisma = {
      listing: { findUnique: jest.fn().mockResolvedValue(listing) },
      booking: { findMany: jest.fn(), findFirst: jest.fn() },
      listingAvailabilityBlock: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AvailabilityService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(AvailabilityService);
  });

  it("returns available when no automatic or manual blocks exist", async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.listingAvailabilityBlock.findMany.mockResolvedValue([]);

    const result = await service.getListingAvailability(
      listing.id,
      startDate,
      endDate,
    );

    expect(result.available).toBe(true);
  });

  it("creates a manual block for the listing owner", async () => {
    prisma.listingAvailabilityBlock.findFirst.mockResolvedValue(null);
    prisma.listingAvailabilityBlock.create.mockResolvedValue({
      id: "block-1",
      listingId: listing.id,
      ownerId: listing.ownerId,
      startDate,
      endDate,
    });

    const result = await service.createBlock(listing.ownerId, listing.id, {
      startDate,
      endDate,
    });

    expect(result.id).toBe("block-1");
    expect(prisma.listingAvailabilityBlock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ listingId: listing.id }),
      }),
    );
  });

  it("rejects manual blocks from non owners", async () => {
    await expect(
      service.createBlock("other-user", listing.id, { startDate, endDate }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects overlapping manual blocks", async () => {
    prisma.listingAvailabilityBlock.findFirst.mockResolvedValue({
      id: "block-1",
    });

    await expect(
      service.createBlock(listing.ownerId, listing.id, { startDate, endDate }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects overlapping active bookings", async () => {
    prisma.booking.findFirst.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.ACCEPTED,
    });

    await expect(
      service.assertListingIsBookable(listing.id, startDate, endDate),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("deletes owner availability block", async () => {
    prisma.listingAvailabilityBlock.findUnique.mockResolvedValue({
      id: "block-1",
      listingId: listing.id,
    });
    prisma.listingAvailabilityBlock.delete.mockResolvedValue({});

    const result = await service.deleteBlock(
      listing.ownerId,
      listing.id,
      "block-1",
    );

    expect(result).toEqual({ deleted: true, id: "block-1" });
  });
});
