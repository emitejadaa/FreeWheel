import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Vehicle } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

type PublicVehicle = Omit<Vehicle, 'ownerId' | 'plate'>;

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  create(ownerId: string, data: CreateVehicleDto) {
    return this.prisma.vehicle.create({
      data: {
        ...data,
        ownerId,
      },
    });
  }

  findMine(ownerId: string) {
    return this.prisma.vehicle.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    return this.toPublicVehicle(vehicle);
  }

  async update(ownerId: string, id: string, data: UpdateVehicleDto) {
    const vehicle = await this.findOwnedRecord(id);

    if (vehicle.ownerId !== ownerId) {
      throw new ForbiddenException('You cannot update this vehicle');
    }

    return this.prisma.vehicle.update({
      where: { id },
      data,
    });
  }

  async remove(ownerId: string, id: string) {
    const vehicle = await this.findOwnedRecord(id);

    if (vehicle.ownerId !== ownerId) {
      throw new ForbiddenException('You cannot delete this vehicle');
    }

    const listingsCount = await this.prisma.listing.count({
      where: { vehicleId: id },
    });

    if (listingsCount > 0) {
      throw new BadRequestException(
        'Vehicle has listings and cannot be deleted',
      );
    }

    await this.prisma.vehicle.delete({ where: { id } });

    return { deleted: true };
  }

  toPublicVehicle(vehicle: Vehicle): PublicVehicle {
    const { ownerId: _ownerId, plate: _plate, ...publicVehicle } = vehicle;

    return publicVehicle;
  }

  private async findOwnedRecord(id: string) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    return vehicle;
  }
}
