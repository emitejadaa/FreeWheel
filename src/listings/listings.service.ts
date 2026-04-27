import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ListingStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateListingDto } from './dto/create-listing.dto';
import { UpdateListingDto } from './dto/update-listing.dto';

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

  findActive() {
    return this.prisma.listing.findMany({
      where: { status: ListingStatus.ACTIVE },
      include: { vehicle: true },
      orderBy: { createdAt: 'desc' },
    });
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

    return listing;
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
}
