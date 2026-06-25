import { Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { PaymentsService } from "./payments.service";

@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post("bookings/:bookingId/sena-intent")
  @UseGuards(JwtAuthGuard)
  createSenaIntent(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.createSenaIntent(user.id, bookingId);
  }

  @Post("bookings/:bookingId/balance-intent")
  @UseGuards(JwtAuthGuard)
  createBalanceIntent(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.createBalanceIntent(user.id, bookingId);
  }

  @Post("bookings/:bookingId/deposit-hold")
  @UseGuards(JwtAuthGuard)
  createDepositHold(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.createDepositHold(user.id, bookingId);
  }

  @Get("bookings/:bookingId/status")
  @UseGuards(JwtAuthGuard)
  getStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.getStatus(user.id, bookingId);
  }

  @Post("connect/onboarding")
  @UseGuards(JwtAuthGuard)
  createOnboarding(@CurrentUser() user: CurrentUserPayload) {
    return this.paymentsService.createOwnerOnboarding(user.id);
  }

  /**
   * Stripe webhook. Public, but verified by signature against the raw request
   * body (express.raw is registered for this exact path in app.factory before
   * the global JSON parser, so `req.body` here is the untouched Buffer).
   */
  @Post("stripe/webhook")
  handleStripeWebhook(@Req() req: Request) {
    const signature = req.headers["stripe-signature"];
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(
          typeof req.body === "string" ? req.body : JSON.stringify(req.body),
        );
    return this.paymentsService.handleWebhook(
      rawBody,
      Array.isArray(signature) ? signature[0] : signature,
    );
  }
}
