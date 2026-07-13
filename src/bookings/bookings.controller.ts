import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { VerifiedAccountGuard } from "../common/guards/verified-account.guard";
import { RequireVerifiedAccount } from "../common/decorators/require-verified-account.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { BookingsService } from "./bookings.service";
import { CancelBookingDto } from "./dto/cancel-booking.dto";
import { ConfirmTokenDto } from "./dto/confirm-token.dto";
import { CreateBookingDto } from "./dto/create-booking.dto";

// Booking mutations are sensitive: only fully verified accounts (phone + DNI +
// license) may move money or vehicles. Read-only routes stay open to any
// authenticated user.
@Controller("bookings")
@UseGuards(JwtAuthGuard, VerifiedAccountGuard)
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post()
  @RequireVerifiedAccount()
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() createBookingDto: CreateBookingDto,
  ) {
    return this.bookingsService.create(user.id, createBookingDto);
  }

  @Get("me")
  findMine(@CurrentUser() user: CurrentUserPayload) {
    return this.bookingsService.findMine(user.id);
  }

  @Get(":id")
  findOne(@CurrentUser() user: CurrentUserPayload, @Param("id") id: string) {
    return this.bookingsService.findOneForParticipant(user.id, id);
  }

  @Patch(":id/accept")
  @RequireVerifiedAccount()
  accept(@CurrentUser() user: CurrentUserPayload, @Param("id") id: string) {
    return this.bookingsService.accept(user.id, id);
  }

  @Patch(":id/reject")
  @RequireVerifiedAccount()
  reject(@CurrentUser() user: CurrentUserPayload, @Param("id") id: string) {
    return this.bookingsService.reject(user.id, id);
  }

  @Patch(":id/cancel")
  @RequireVerifiedAccount()
  cancel(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() cancelBookingDto: CancelBookingDto,
  ) {
    return this.bookingsService.cancel(user.id, id, cancelBookingDto);
  }

  @Patch(":id/ready-for-pickup")
  @RequireVerifiedAccount()
  readyForPickup(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
  ) {
    return this.bookingsService.readyForPickup(user.id, id);
  }

  @Get(":id/tokens")
  getTokens(@CurrentUser() user: CurrentUserPayload, @Param("id") id: string) {
    return this.bookingsService.getTokens(user.id, id);
  }

  @Post(":id/confirm-pickup")
  @RequireVerifiedAccount()
  confirmPickup(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() confirmTokenDto: ConfirmTokenDto,
  ) {
    return this.bookingsService.confirmPickup(
      user.id,
      id,
      confirmTokenDto.token,
    );
  }

  @Post(":id/confirm-return")
  @RequireVerifiedAccount()
  confirmReturn(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() confirmTokenDto: ConfirmTokenDto,
  ) {
    return this.bookingsService.confirmReturn(
      user.id,
      id,
      confirmTokenDto.token,
    );
  }
}
