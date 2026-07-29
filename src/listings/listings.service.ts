import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Listing,
  ListingStatus,
  MediaAssetKind,
  MediaAssetStatus,
  Prisma,
  Vehicle,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  blockingBookingStatuses,
  overlappingRangeWhere,
} from "../availability/availability.service";
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
// El precio pendiente de confirmar es información del dueño, no del aviso: si
// se publicara, cualquiera vería el precio nuevo antes de que se aplique.
type PublicListing = Omit<
  Listing,
  "ownerId" | "pendingPricePerDay" | "priceChangeRequestedAt"
> & {
  vehicle: Omit<Vehicle, "ownerId" | "plate">;
  owner: OwnerPublic;
};
type PublicListingWithPhotos = PublicListing & { photos: string[] };

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

    return {
      data: await this.withPhotos(listings),
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

    return this.withPhotos(listings);
  }

  /**
   * Forma pública de un conjunto de publicaciones con sus fotos resueltas en
   * una sola consulta. Lo usan la búsqueda, "mis autos" y los favoritos.
   */
  async withPhotos(
    listings: ListingWithVehicleAndOwner[],
  ): Promise<PublicListingWithPhotos[]> {
    const photosByVehicle = await this.getPhotosByVehicleIds(
      listings.map((l) => l.vehicleId),
    );

    return listings.map((listing) => ({
      ...this.toPublicListing(listing),
      photos: photosByVehicle[listing.vehicleId] ?? [],
    }));
  }

  /**
   * Detalle público de una publicación. El dueño (viewerId) también puede ver
   * las suyas cuando están en DRAFT o PAUSED: si no, "Mis autos" enlazaría a un
   * 404 en cuanto pausa un aviso.
   */
  async findOne(id: string, viewerId?: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      include: { vehicle: true, owner: { select: USER_PUBLIC_SELECT } },
    });

    const visible =
      listing &&
      (listing.status === ListingStatus.ACTIVE ||
        (listing.status !== ListingStatus.DELETED &&
          listing.ownerId === viewerId));

    if (!listing || !visible) {
      throw new NotFoundException("Listing not found");
    }

    const publicListing = this.toPublicListing(listing);
    const photos = await this.getPhotosByVehicleId(listing.vehicleId);
    return { ...publicListing, photos, isOwner: listing.ownerId === viewerId };
  }

  async update(ownerId: string, id: string, data: UpdateListingDto) {
    const listing = await this.findEditable(id);
    assertOwner(listing.ownerId, ownerId, "You cannot update this listing");

    // El precio NO se cambia por acá. Es el único dato que mueve plata sin que
    // intervenga nadie más, así que pasa por su propio circuito con confirmación
    // por email y tiempo de espera entre cambios (PriceChangeService). Antes se
    // podía cambiar con un PATCH cualquiera, igual que una coma en el título.
    if (
      data.pricePerDay !== undefined &&
      Math.round(data.pricePerDay) !== Math.round(listing.pricePerDay)
    ) {
      throw new BadRequestException(
        "El precio se cambia desde 'Cambiar precio': pedimos una confirmación " +
          "por email antes de aplicarlo.",
      );
    }
    const { pricePerDay: _ignoredPrice, ...editable } = data;

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
      data: editable,
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
    const {
      ownerId: _ownerId,
      pendingPricePerDay: _pendingPrice,
      priceChangeRequestedAt: _priceRequestedAt,
      vehicle,
      owner,
      ...publicListing
    } = listing;
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

  /** Público: lo reutiliza FavoritesService para devolver las fotos de cada auto. */
  async getPhotosByVehicleIds(
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
    // Todos los filtros que viajan sobre el vehículo se acumulan en un único
    // `where.vehicle`: si se armaran por separado, el último sobrescribiría a
    // los anteriores y el buscador devolvería resultados de más.
    const vehicleWhere: Prisma.VehicleWhereInput = {
      ...(query.brand
        ? { brand: { contains: query.brand, mode: "insensitive" } }
        : {}),
      ...(query.model
        ? { model: { contains: query.model, mode: "insensitive" } }
        : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.transmission ? { transmission: query.transmission } : {}),
      ...(query.fuelType ? { fuelType: query.fuelType } : {}),
      ...(query.minSeats !== undefined
        ? { seats: { gte: query.minSeats } }
        : {}),
    };
    if (Object.keys(vehicleWhere).length > 0) {
      where.vehicle = vehicleWhere;
    }
    // Con un rango de fechas pedido, se descartan las publicaciones que ya
    // tengan una reserva o un bloqueo del dueño encima de esos días.
    //
    // El solapamiento lo calcula overlappingRangeWhere(), la MISMA función que
    // usa el detalle de disponibilidad del auto. Antes cada lado tenía su propia
    // comparación y no coincidían: el panel del auto avisaba "30 jul ocupado" y
    // este filtro devolvía ese mismo auto como disponible si se buscaba del 30
    // al 30.
    if (query.startDate && query.endDate) {
      const overlap = overlappingRangeWhere(query.startDate, query.endDate);
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        {
          bookings: {
            none: { status: { in: blockingBookingStatuses }, ...overlap },
          },
        },
        { availabilityBlocks: { none: overlap } },
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
