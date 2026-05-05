import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingStatus,
  Listing,
  ListingStatus,
  Prisma,
  Vehicle,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateListingDto } from './dto/create-listing.dto';
import {
  ListingSort,
  ListListingsQueryDto,
} from './dto/list-listings-query.dto';
import { UpdateListingDto } from './dto/update-listing.dto';

type ListingWithVehicle = Listing & { vehicle: Vehicle };
type PublicListing = Omit<Listing, 'ownerId'> & {
  vehicle: Omit<Vehicle, 'ownerId' | 'plate'>;
};

@Injectable()
export class ListingsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerId: string, data: CreateListingDto) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: data.vehicleId },
    });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    if (vehicle.ownerId !== ownerId) {
      throw new ForbiddenException(
        'You cannot create listings for this vehicle',
      );
    }

    return this.prisma.listing.create({
      data: {
        ...data,
        ownerId,
      },
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
        include: { vehicle: true },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: listings.map((listing) => this.toPublicListing(listing)),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findActiveListForLegacyTests(): Promise<PublicListing[]> {
    const listings = await this.prisma.listing.findMany({
      where: this.buildPublicWhere({}),
      include: { vehicle: true },
      orderBy: { createdAt: 'desc' },
    });

    return listings.map((listing) => this.toPublicListing(listing));
  }

  findMine(ownerId: string) {
    return this.prisma.listing.findMany({
      where: { ownerId },
      include: { vehicle: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      include: { vehicle: true },
    });

    if (!listing || listing.status !== ListingStatus.ACTIVE) {
      throw new NotFoundException('Listing not found');
    }

    return this.toPublicListing(listing);
  }

  async update(ownerId: string, id: string, data: UpdateListingDto) {
    const listing = await this.findEditable(id);

    if (listing.ownerId !== ownerId) {
      throw new ForbiddenException('You cannot update this listing');
    }

    if (data.vehicleId) {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: data.vehicleId },
      });

      if (!vehicle) {
        throw new NotFoundException('Vehicle not found');
      }

      if (vehicle.ownerId !== ownerId) {
        throw new ForbiddenException(
          'You cannot assign this listing to that vehicle',
        );
      }
    }

    return this.prisma.listing.update({
      where: { id },
      data,
      include: { vehicle: true },
    });
  }

  async remove(ownerId: string, id: string) {
    const listing = await this.findEditable(id);

    if (listing.ownerId !== ownerId) {
      throw new ForbiddenException('You cannot delete this listing');
    }

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
      throw new NotFoundException('Listing not found');
    }

    return listing;
  }

  private toPublicListing(listing: ListingWithVehicle): PublicListing {
    const { ownerId: _ownerId, vehicle, ...publicListing } = listing;
    const {
      ownerId: _vehicleOwnerId,
      plate: _plate,
      ...publicVehicle
    } = vehicle;

    return {
      ...publicListing,
      vehicle: publicVehicle,
    };
  }

  private buildPublicWhere(
    query: ListListingsQueryDto,
  ): Prisma.ListingWhereInput {
    const where: Prisma.ListingWhereInput = {
      status: ListingStatus.ACTIVE,
    };

    if (query.locationText) {
      where.locationText = {
        contains: query.locationText,
        mode: 'insensitive',
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
          ? { brand: { contains: query.brand, mode: 'insensitive' } }
          : {}),
        ...(query.model
          ? { model: { contains: query.model, mode: 'insensitive' } }
          : {}),
      };
    }

    if (query.startDate && query.endDate) {
      where.bookings = {
        none: {
          status: {
            in: [
              BookingStatus.ACCEPTED,
              BookingStatus.READY_FOR_PICKUP,
              BookingStatus.IN_PROGRESS,
              BookingStatus.RETURN_PENDING,
            ],
          },
          startDate: { lt: query.endDate },
          endDate: { gt: query.startDate },
        },
      };
    }

    return where;
  }

  private buildOrderBy(
    sort: ListingSort = ListingSort.NEWEST,
  ): Prisma.ListingOrderByWithRelationInput {
    if (sort === ListingSort.PRICE_ASC) {
      return { pricePerDay: 'asc' };
    }

    if (sort === ListingSort.PRICE_DESC) {
      return { pricePerDay: 'desc' };
    }

    return { createdAt: 'desc' };
  }
}
