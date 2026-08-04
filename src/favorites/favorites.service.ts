import { Injectable, NotFoundException } from "@nestjs/common";
import { ListingStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ListingsService } from "../listings/listings.service";
import { USER_PUBLIC_SELECT } from "../common/constants/prisma-select";

/**
 * Favoritos ("me gusta") de un usuario sobre publicaciones. Guardarlos en la
 * base y no en el navegador es lo que permite que la sección Favoritos muestre
 * lo mismo desde cualquier dispositivo.
 */
@Injectable()
export class FavoritesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly listings: ListingsService,
  ) {}

  /** Publicaciones marcadas como favoritas, en formato de listado. */
  async findMine(userId: string) {
    const favorites = await this.prisma.favorite.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: {
        listing: {
          include: { vehicle: true, owner: { select: USER_PUBLIC_SELECT } },
        },
      },
    });

    // Un aviso borrado deja de mostrarse, pero el favorito no se elimina: si el
    // dueño lo vuelve a activar, reaparece.
    const visible = favorites.filter(
      (favorite) => favorite.listing.status !== ListingStatus.DELETED,
    );

    return this.listings.withPhotos(visible.map((f) => f.listing));
  }

  /** Solo los ids: alcanza para pintar los corazones en las grillas. */
  async findMyIds(userId: string) {
    const favorites = await this.prisma.favorite.findMany({
      where: { userId },
      select: { listingId: true },
    });

    return favorites.map((favorite) => favorite.listingId);
  }

  /** Idempotente: marcar dos veces el mismo auto deja un único favorito. */
  async add(userId: string, listingId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { id: true, status: true },
    });

    if (!listing || listing.status === ListingStatus.DELETED) {
      throw new NotFoundException("Listing not found");
    }

    await this.prisma.favorite.upsert({
      where: { userId_listingId: { userId, listingId } },
      update: {},
      create: { userId, listingId },
    });

    return { listingId, favorite: true };
  }

  /** Idempotente: quitar algo que no estaba en favoritos no es un error. */
  async remove(userId: string, listingId: string) {
    await this.prisma.favorite.deleteMany({ where: { userId, listingId } });

    return { listingId, favorite: false };
  }
}
