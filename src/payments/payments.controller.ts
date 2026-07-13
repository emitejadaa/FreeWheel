import { Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { VerifiedAccountGuard } from "../common/guards/verified-account.guard";
import { RequireVerifiedAccount } from "../common/decorators/require-verified-account.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { PaymentsService } from "./payments.service";

// Every payment action requires a fully verified account (phone + DNI +
// license). The Stripe webhook stays public: it authenticates by signature.
@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post("bookings/:bookingId/sena-intent")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  createSenaIntent(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.createSenaIntent(user.id, bookingId);
  }

  @Post("bookings/:bookingId/balance-intent")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  createBalanceIntent(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.createBalanceIntent(user.id, bookingId);
  }

  @Post("bookings/:bookingId/deposit-hold")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  createDepositHold(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.createDepositHold(user.id, bookingId);
  }

  @Get("bookings/:bookingId/status")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  getStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.getStatus(user.id, bookingId);
  }

  @Post("connect/onboarding")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
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
