import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../common/types/current-user.type';
import { BookingsService } from './bookings.service';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { ConfirmTokenDto } from './dto/confirm-token.dto';
import { CreateBookingDto } from './dto/create-booking.dto';

@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post()
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() createBookingDto: CreateBookingDto,
  ) {
    return this.bookingsService.create(user.id, createBookingDto);
  }

  @Get('me')
  findMine(@CurrentUser() user: CurrentUserPayload) {
    return this.bookingsService.findMine(user.id);
  }

  @Get(':id')
  findOne(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.bookingsService.findOneForParticipant(user.id, id);
  }

  @Patch(':id/accept')
  accept(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.bookingsService.accept(user.id, id);
  }

  @Patch(':id/reject')
  reject(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.bookingsService.reject(user.id, id);
  }

  @Patch(':id/cancel')
  cancel(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() cancelBookingDto: CancelBookingDto,
  ) {
    return this.bookingsService.cancel(user.id, id, cancelBookingDto);
  }

  @Patch(':id/ready-for-pickup')
  readyForPickup(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
  ) {
    return this.bookingsService.readyForPickup(user.id, id);
  }

  @Get(':id/tokens')
  getTokens(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.bookingsService.getTokens(user.id, id);
  }

  @Post(':id/confirm-pickup')
  confirmPickup(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() confirmTokenDto: ConfirmTokenDto,
  ) {
    return this.bookingsService.confirmPickup(
      user.id,
      id,
      confirmTokenDto.token,
    );
  }

  @Post(':id/confirm-return')
  confirmReturn(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() confirmTokenDto: ConfirmTokenDto,
  ) {
    return this.bookingsService.confirmReturn(
      user.id,
      id,
      confirmTokenDto.token,
    );
  }
}
