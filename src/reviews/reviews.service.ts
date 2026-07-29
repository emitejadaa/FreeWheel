import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { BookingStatus, PaymentStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { assertFound } from "../common/utils/entity.util";
import { USER_PUBLIC_SELECT } from "../common/constants/prisma-select";
import { CreateReviewDto } from "./dto/create-review.dto";

/**
 * Estados de pago que cuentan como "el dinero se movió". Reseñar exige que la
 * reserva se haya pagado: es lo que separa una opinión real de cualquiera que
 * pase y puntúe.
 */
const PAID_STATUSES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.FULLY_PAID,
  PaymentStatus.PARTIALLY_REFUNDED,
];

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Escribe la reseña de una reserva terminada.
   *
   * Las dos partes pueden reseñarse: quien alquiló puntúa al dueño y a la
   * publicación, y el dueño puntúa a quien alquiló. Cada uno puede dejar una sola
   * reseña por reserva.
   */
  async createForBooking(
    authorId: string,
    bookingId: string,
    data: CreateReviewDto,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    assertFound(booking, "Booking not found");

    const isRenter = booking.renterId === authorId;
    const isOwner = booking.ownerId === authorId;
    if (!isRenter && !isOwner) {
      throw new ForbiddenException("No participaste de esta reserva");
    }

    if (booking.status !== BookingStatus.COMPLETED) {
      throw new BadRequestException(
        "Se puede reseñar cuando la reserva está completada",
      );
    }

    if (!PAID_STATUSES.includes(booking.paymentStatus)) {
      throw new BadRequestException(
        "Se puede reseñar cuando el pago de la reserva se completó",
      );
    }

    const existing = await this.prisma.review.findUnique({
      where: { bookingId_authorId: { bookingId, authorId } },
    });
    if (existing) {
      throw new BadRequestException("Ya dejaste tu reseña de esta reserva");
    }

    // El dueño reseña a quien alquiló y viceversa.
    const targetUserId = isRenter ? booking.ownerId : booking.renterId;

    const review = await this.prisma.review.create({
      data: {
        bookingId,
        authorId,
        targetUserId,
        // Solo la reseña de quien alquiló habla del auto y cuenta para el
        // promedio de la publicación.
        listingId: isRenter ? booking.listingId : null,
        rating: data.rating,
        comment: data.comment,
      },
      include: { author: { select: USER_PUBLIC_SELECT } },
    });

    // Los promedios se recalculan y se guardan. La reseña de quien alquiló es la
    // que cuenta para la publicación: la del dueño es sobre la persona, no sobre
    // el auto.
    await this.recalculateUser(targetUserId);
    if (isRenter) await this.recalculateListing(booking.listingId);

    this.logger.log(
      `Reseña ${review.id} de la reserva ${bookingId} (${data.rating}/5)`,
    );
    return review;
  }

  /** Reseñas públicas de una publicación, de la más nueva a la más vieja. */
  listForListing(listingId: string) {
    return this.prisma.review.findMany({
      // Con listingId cargado solo quedan las de quien alquiló: las del dueño
      // hacia la otra persona tienen listingId en null.
      where: { listingId },
      include: { author: { select: USER_PUBLIC_SELECT } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  /** Reseñas recibidas por una persona (lo que se ve en su perfil). */
  listForUser(userId: string) {
    return this.prisma.review.findMany({
      where: { targetUserId: userId },
      include: { author: { select: USER_PUBLIC_SELECT } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  /**
   * Para las pantallas de reservas: por cada reserva propia, si ya se puede
   * reseñar y si ya se reseñó. Evita que el front tenga que adivinar la regla.
   */
  async myReviewableBookings(userId: string) {
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.COMPLETED,
        paymentStatus: { in: PAID_STATUSES },
        OR: [{ renterId: userId }, { ownerId: userId }],
      },
      select: { id: true, listingId: true, ownerId: true, renterId: true },
    });

    const mine = await this.prisma.review.findMany({
      where: { authorId: userId, bookingId: { in: bookings.map((b) => b.id) } },
      select: { bookingId: true, rating: true, comment: true },
    });
    const byBooking = new Map(mine.map((r) => [r.bookingId, r]));

    return bookings.map((booking) => ({
      bookingId: booking.id,
      listingId: booking.listingId,
      role: booking.renterId === userId ? "renter" : "owner",
      alreadyReviewed: byBooking.has(booking.id),
      myReview: byBooking.get(booking.id) ?? null,
    }));
  }

  /** Recalcula y guarda el promedio de una publicación. */
  private async recalculateListing(listingId: string) {
    const stats = await this.aggregate({ listingId });
    await this.prisma.listing.update({
      where: { id: listingId },
      data: stats,
    });
  }

  /** Recalcula y guarda el promedio de una persona. */
  private async recalculateUser(userId: string) {
    const stats = await this.aggregate({ targetUserId: userId });
    await this.prisma.user.update({ where: { id: userId }, data: stats });
  }

  /**
   * Promedio y cantidad reales, calculados por la base. Se redondea a un decimal
   * para no mostrar "4.333333333".
   */
  private async aggregate(where: Prisma.ReviewWhereInput) {
    const result = await this.prisma.review.aggregate({
      where,
      _avg: { rating: true },
      _count: { rating: true },
    });

    const average = result._avg.rating;
    return {
      ratingAverage: average === null ? null : Math.round(average * 10) / 10,
      ratingCount: result._count.rating,
    };
  }
}
