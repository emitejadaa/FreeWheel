import { Injectable, NotFoundException } from "@nestjs/common";
import {
  Listing,
  ListingStatus,
  MediaAssetKind,
  MediaAssetStatus,
  Prisma,
  Vehicle,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { blockingBookingStatuses } from "../availability/availability.service";
import { assertFound } from "../common/utils/entity.util";
import { assertOwner } from "../common/utils/authorization.util";
import { USER_PUBLIC_SELECT } from "../common/constants/prisma-select";
import { CreateListingDto } from "./dto/create-listing.dto";
import {
  ListingSort,
  ListListingsQueryDto,
} from "./dto/list-listings-query.dto";
import { UpdateListingDto } from "./dto/update-listing.dto";

type OwnerPublic = {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
};
type ListingWithVehicleAndOwner = Listing & {
  vehicle: Vehicle;
  owner: OwnerPublic;
};
type PublicListing = Omit<Listing, "ownerId"> & {
  vehicle: Omit<Vehicle, "ownerId" | "plate">;
  owner: OwnerPublic;
};

@Injectable()
export class ListingsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerId: string, data: CreateListingDto) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: data.vehicleId },
    });
    assertFound(vehicle, "Vehicle not found");
    assertOwner(
      vehicle.ownerId,
      ownerId,
      "You cannot create listings for this vehicle",
    );

    return this.prisma.listing.create({
      data: { ...data, ownerId },
      include: { vehicle: true },
    });
  }

  async findActive(query: ListListingsQueryDto = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = this.buildPublicWhere(query);
    const orderBy = this.buildOrderBy(query.sort);

    const [total, listings] = await this.prisma.$transaction([
      this.prisma.listing.count({ where }),
      this.prisma.listing.findMany({
        where,
        include: { vehicle: true, owner: { select: USER_PUBLIC_SELECT } },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const photosByVehicle = await this.getPhotosByVehicleIds(
      listings.map((l) => l.vehicleId),
    );

    return {
      data: listings.map((listing) => ({
        ...this.toPublicListing(listing),
        photos: photosByVehicle[listing.vehicleId] ?? [],
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findMine(ownerId: string) {
    const listings = await this.prisma.listing.findMany({
      where: { ownerId },
      include: { vehicle: true, owner: { select: USER_PUBLIC_SELECT } },
      orderBy: { createdAt: "desc" },
    });

    const photosByVehicle = await this.getPhotosByVehicleIds(
      listings.map((l) => l.vehicleId),
    );

    return listings.map((listing) => ({
      ...this.toPublicListing(listing),
      photos: photosByVehicle[listing.vehicleId] ?? [],
    }));
  }

  async findOne(id: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      include: { vehicle: true, owner: { select: USER_PUBLIC_SELECT } },
    });

    if (!listing || listing.status !== ListingStatus.ACTIVE) {
      throw new NotFoundException("Listing not found");
    }

    const publicListing = this.toPublicListing(listing);
    const photos = await this.getPhotosByVehicleId(listing.vehicleId);
    return { ...publicListing, photos };
  }

  async update(ownerId: string, id: string, data: UpdateListingDto) {
    const listing = await this.findEditable(id);
    assertOwner(listing.ownerId, ownerId, "You cannot update this listing");

    if (data.vehicleId) {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: data.vehicleId },
      });
      assertFound(vehicle, "Vehicle not found");
      assertOwner(
        vehicle.ownerId,
        ownerId,
        "You cannot assign this listing to that vehicle",
      );
    }

    return this.prisma.listing.update({
      where: { id },
      data,
      include: { vehicle: true },
    });
  }

  async remove(ownerId: string, id: string) {
    const listing = await this.findEditable(id);
    assertOwner(listing.ownerId, ownerId, "You cannot delete this listing");

    return this.prisma.listing.update({
      where: { id },
      data: { status: ListingStatus.DELETED },
    });
  }

  private async findEditable(id: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      include: { vehicle: true },
    });

    if (!listing || listing.status === ListingStatus.DELETED) {
      throw new NotFoundException("Listing not found");
    }

    return listing;
  }

  private toPublicListing(listing: ListingWithVehicleAndOwner): PublicListing {
    const { ownerId: _ownerId, vehicle, owner, ...publicListing } = listing;
    const {
      ownerId: _vehicleOwnerId,
      plate: _plate,
      ...publicVehicle
    } = vehicle;
    return { ...publicListing, vehicle: publicVehicle, owner };
  }

  private async getPhotosByVehicleId(vehicleId: string): Promise<string[]> {
    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        entityType: "vehicle",
        entityId: vehicleId,
        kind: MediaAssetKind.VEHICLE_PHOTO,
        status: MediaAssetStatus.ACTIVE,
      },
      select: { url: true },
      orderBy: { createdAt: "asc" },
    });
    return assets.map((a) => a.url);
  }

  private async getPhotosByVehicleIds(
    vehicleIds: string[],
  ): Promise<Record<string, string[]>> {
    if (vehicleIds.length === 0) return {};
    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        entityType: "vehicle",
        entityId: { in: vehicleIds },
        kind: MediaAssetKind.VEHICLE_PHOTO,
        status: MediaAssetStatus.ACTIVE,
      },
      select: { entityId: true, url: true },
      orderBy: { createdAt: "asc" },
    });
    return assets.reduce(
      (acc, a) => {
        const id = a.entityId!;
        if (!acc[id]) acc[id] = [];
        acc[id].push(a.url);
        return acc;
      },
      {} as Record<string, string[]>,
    );
  }

  private buildPublicWhere(
    query: ListListingsQueryDto,
  ): Prisma.ListingWhereInput {
    const where: Prisma.ListingWhereInput = { status: ListingStatus.ACTIVE };

    if (query.locationText) {
      where.locationText = {
        contains: query.locationText,
        mode: "insensitive",
      };
    }

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.pricePerDay = {
        ...(query.minPrice !== undefined ? { gte: query.minPrice } : {}),
        ...(query.maxPrice !== undefined ? { lte: query.maxPrice } : {}),
      };
    }
    if (query.brand || query.model) {
      where.vehicle = {
        ...(query.brand
          ? { brand: { contains: query.brand, mode: "insensitive" } }
          : {}),
        ...(query.model
          ? { model: { contains: query.model, mode: "insensitive" } }
          : {}),
      };
    }
    // When a date range is requested, drop listings that already have a blocking
    // booking or an owner availability block overlapping it. Overlap uses the
    // standard half-open test: existing.start < requestedEnd && existing.end >
    // requestedStart.
    if (query.startDate && query.endDate) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        {
          bookings: {
            none: {
              status: { in: blockingBookingStatuses },
              startDate: { lt: query.endDate },
              endDate: { gt: query.startDate },
            },
          },
        },
        {
          availabilityBlocks: {
            none: {
              startDate: { lt: query.endDate },
              endDate: { gt: query.startDate },
            },
          },
        },
      ];
    }
    return where;
  }

  private buildOrderBy(
    sort: ListingSort = ListingSort.NEWEST,
  ): Prisma.ListingOrderByWithRelationInput {
    if (sort === ListingSort.PRICE_ASC) return { pricePerDay: "asc" };
    if (sort === ListingSort.PRICE_DESC) return { pricePerDay: "desc" };
    return { createdAt: "desc" };
  }
}
