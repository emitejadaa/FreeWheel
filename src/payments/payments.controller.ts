import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { MockWebhookDto } from "./dto/mock-webhook.dto";
import { PaymentsService } from "./payments.service";

@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post("bookings/:bookingId/mock-intent")
  @UseGuards(JwtAuthGuard)
  createMockIntent(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.createMockIntent(user.id, bookingId);
  }

  @Get("bookings/:bookingId/status")
  @UseGuards(JwtAuthGuard)
  getStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.getBookingPaymentStatus(user.id, bookingId);
  }

  @Post("bookings/:bookingId/mock-confirm")
  @UseGuards(JwtAuthGuard)
  confirmMock(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.confirmMockPayment(user.id, bookingId);
  }

  @Post("bookings/:bookingId/mock-fail")
  @UseGuards(JwtAuthGuard)
  failMock(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.failMockPayment(user.id, bookingId);
  }

  @Post("bookings/:bookingId/mock-refund")
  @UseGuards(JwtAuthGuard)
  refundMock(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.refundMockPayment(user.id, bookingId);
  }

  @Post("mock/webhook")
  handleMockWebhook(@Body() dto: MockWebhookDto) {
    return this.paymentsService.handleMockWebhook(dto);
  }
}
