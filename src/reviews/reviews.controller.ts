import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { CreateReviewDto } from "./dto/create-review.dto";
import { ReviewsService } from "./reviews.service";

@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** Reseñas de una publicación. Público: se muestran en el detalle del auto. */
  @Get("listings/:listingId/reviews")
  listForListing(@Param("listingId") listingId: string) {
    return this.reviews.listForListing(listingId);
  }

  /** Reseñas recibidas por una persona. Público: se muestran en su perfil. */
  @Get("users/:userId/reviews")
  listForUser(@Param("userId") userId: string) {
    return this.reviews.listForUser(userId);
  }

  /**
   * Reputación de una persona separada por rol: cómo la calificaron como
   * conductor y cómo la calificaron como dueño. Es lo que se muestra al lado de
   * una solicitud de reserva y en el perfil que se abre desde el chat.
   */
  @Get("users/:userId/reputation")
  reputation(@Param("userId") userId: string) {
    return this.reviews.reputationFor(userId);
  }

  /**
   * Qué reservas propias se pueden reseñar y cuáles ya se reseñaron. El front lo
   * usa para mostrar el botón solo donde corresponde.
   */
  @Get("reviews/me/pending")
  @UseGuards(JwtAuthGuard)
  myReviewable(@CurrentUser() user: CurrentUserPayload) {
    return this.reviews.myReviewableBookings(user.id);
  }

  /** Deja la reseña de una reserva terminada y pagada. */
  @Post("bookings/:bookingId/reviews")
  @UseGuards(JwtAuthGuard)
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviews.createForBooking(user.id, bookingId, dto);
  }
}
