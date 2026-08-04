import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { VerifiedAccountGuard } from "../common/guards/verified-account.guard";
import { RequireVerifiedAccount } from "../common/decorators/require-verified-account.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { SimulatePaymentDto } from "./dto/simulate-payment.dto";
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

  /**
   * Simulación de pago para la demo (solo con PAYMENTS_PROVIDER=mock): cobra
   * seña + saldo y autoriza el depósito en un solo paso, de modo que el dueño
   * pueda seguir con "listo para retiro". Sin esto, en modo mock nadie firma el
   * webhook y la reserva nunca llega a estar paga.
   */
  @Post("bookings/:bookingId/mock-confirm")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  mockConfirm(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Body() dto: SimulatePaymentDto,
  ) {
    return this.paymentsService.simulatePaymentSuccess(
      user.id,
      bookingId,
      dto.kind,
    );
  }

  @Post("bookings/:bookingId/mock-fail")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  mockFail(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Body() dto: SimulatePaymentDto,
  ) {
    return this.paymentsService.simulatePaymentFailure(
      user.id,
      bookingId,
      dto.kind,
    );
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
