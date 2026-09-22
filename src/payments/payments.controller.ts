import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { UserRole } from "@prisma/client";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { VerifiedAccountGuard } from "../common/guards/verified-account.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { RequireVerifiedAccount } from "../common/decorators/require-verified-account.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { CaptureDepositDto } from "./dto/capture-deposit.dto";
import { LedgerRemittanceDto } from "./dto/ledger-remittance.dto";
import { clientIp, clientUserAgent } from "../common/utils/client-ip.util";
import { SensitiveRateLimit } from "../common/rate-limit/sensitive-rate-limit.decorator";
import { SimulatePaymentDto } from "./dto/simulate-payment.dto";
import { PaymentsService } from "./payments.service";
import type { PaymentContext } from "./payments.service";

/**
 * DE DÓNDE SALIÓ ESTE PEDIDO: la IP real del cliente y su navegador, que se
 * guardan con cada cobro (ver clientIp: detrás de Vercel, req.ip es la del
 * proxy y no identifica a nadie).
 */
function contextOf(req: Request, actorId?: string): PaymentContext {
  return {
    actorId: actorId ?? null,
    ip: clientIp(req),
    userAgent: clientUserAgent(req),
  };
}

// Toda acción de pago exige una cuenta verificada, con el DNI vigente. El
// webhook de Stripe queda público: se autentica por firma.
@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * EL PAGO DE LA RESERVA: alquiler + cobertura, de una sola vez. Exige que
   * quien alquila haya aceptado el contrato (409 CONTRACT_NOT_ACCEPTED).
   *
   * Los límites son más bajos que el general del servidor, y no es por costo:
   * crear intents contra un procesador es la forma barata de probar tarjetas
   * robadas de a cientos, y un límite es lo único que la frena.
   */
  @Throttle({ default: { limit: 20, ttl: 600_000 } })
  @SensitiveRateLimit({
    name: "payments.checkout",
    limit: 20,
    windowSec: 600,
    by: "ip+user",
  })
  @Post("bookings/:bookingId/checkout")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  createCheckout(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Req() req: Request,
  ) {
    return this.paymentsService.createCheckout(
      user.id,
      bookingId,
      contextOf(req, user.id),
    );
  }

  /** El detalle de lo que se paga y a dónde va cada peso, antes de pagar. */
  @Get("bookings/:bookingId/ticket")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  getTicket(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.getTicket(user.id, bookingId);
  }

  /** DEPRECADO: alias del cobro único (ver createSenaIntent en el servicio). */
  @Throttle({ default: { limit: 20, ttl: 600_000 } })
  @SensitiveRateLimit({
    name: "payments.checkout",
    limit: 20,
    windowSec: 600,
    by: "ip+user",
  })
  @Post("bookings/:bookingId/sena-intent")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  createSenaIntent(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Req() req: Request,
  ) {
    return this.paymentsService.createSenaIntent(
      user.id,
      bookingId,
      contextOf(req, user.id),
    );
  }

  /** DEPRECADO: el pago es uno solo (409 PAYMENT_IS_SINGLE salvo reservas viejas). */
  @Throttle({ default: { limit: 20, ttl: 600_000 } })
  @Post("bookings/:bookingId/balance-intent")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  createBalanceIntent(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Req() req: Request,
  ) {
    return this.paymentsService.createBalanceIntent(
      user.id,
      bookingId,
      contextOf(req, user.id),
    );
  }

  /**
   * Autorizar el depósito con quien alquila presente. Es el plan B: lo normal
   * es que el servidor lo autorice solo cuando el dueño marca el auto listo.
   */
  @Throttle({ default: { limit: 20, ttl: 600_000 } })
  @SensitiveRateLimit({
    name: "payments.deposit",
    limit: 20,
    windowSec: 600,
    by: "ip+user",
  })
  @Post("bookings/:bookingId/deposit-hold")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  createDepositHold(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Req() req: Request,
  ) {
    return this.paymentsService.createDepositHold(
      user.id,
      bookingId,
      contextOf(req, user.id),
    );
  }

  /**
   * Simulación de pago SIN pasar por el procesador.
   *
   * Existe solo para los tests automatizados, que corren con
   * PAYMENTS_PROVIDER=mock. Con el provider Stripe —que es el de la demo y el
   * de producción— contesta 403: ahí el pago lo confirma Stripe y el aviso
   * llega por webhook, exactamente como va a pasar el día que se cobre de
   * verdad.
   */
  @Post("bookings/:bookingId/mock-confirm")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  mockConfirm(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Body() dto: SimulatePaymentDto,
    @Req() req: Request,
  ) {
    return this.paymentsService.simulatePaymentSuccess(
      user.id,
      bookingId,
      dto.kind,
      contextOf(req, user.id),
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

  /**
   * El historial completo de los pagos de una reserva, en orden.
   *
   * Lo ven las dos partes. La IP, el navegador y el detalle del procesador
   * solo los ve un administrador: al dueño del auto le sirve saber qué pasó y
   * cuándo, no desde dónde se conecta quien se lo alquiló.
   */
  @Get("bookings/:bookingId/ledger")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  getLedger(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.getLedger(
      user.id,
      bookingId,
      user.role === UserRole.ADMIN,
    );
  }

  @Post("connect/onboarding")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  createOnboarding(@CurrentUser() user: CurrentUserPayload) {
    return this.paymentsService.createOwnerOnboarding(user.id);
  }

  /**
   * Si este dueño ya puede cobrar.
   *
   * Sin esto, alguien completaba a medias el alta en Stripe, publicaba su
   * auto, y recién al devolverlo descubría que la transferencia no salía.
   */
  @Get("connect/status")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  getConnectStatus(@CurrentUser() user: CurrentUserPayload) {
    return this.paymentsService.getOwnerPayoutStatus(user.id);
  }

  /**
   * COBRAR PARTE DEL DEPÓSITO EN GARANTÍA POR UN DAÑO.
   *
   * Solo un administrador. Es plata de otra persona y hay dos partes con
   * intereses opuestos: si el dueño pudiera capturar solo, el depósito sería
   * un botón para quedarse con la garantía de quien alquiló sin que nadie
   * mire. El dueño reclama, la plataforma resuelve.
   */
  @Post("bookings/:bookingId/deposit-capture")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  captureDeposit(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Body() dto: CaptureDepositDto,
    @Req() req: Request,
  ) {
    return this.paymentsService.captureDeposit(
      user.id,
      bookingId,
      dto.amountMinor,
      dto.reason,
      contextOf(req, user.id),
    );
  }

  // ── Administración del libro ─────────────────────────────────────────

  /**
   * Cuánto hay en cada bolsillo: señas retenidas por reserva, lo que se le
   * debe a cada dueño, lo cobrado por cuenta de la aseguradora, la comisión.
   * `?prefix=owner:` filtra.
   */
  @Get("admin/ledger/balances")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  ledgerBalances(@Query("prefix") prefix?: string) {
    return this.paymentsService.ledgerBalances(prefix);
  }

  /** Todos los asientos de una reserva, con sus líneas. */
  @Get("admin/ledger/bookings/:bookingId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  ledgerForBooking(@Param("bookingId") bookingId: string) {
    return this.paymentsService.ledgerForBooking(bookingId);
  }

  /** Registra un pago a la aseguradora de lo cobrado por su cuenta. */
  @Post("admin/ledger/insurance-remittance")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  insuranceRemittance(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: LedgerRemittanceDto,
  ) {
    return this.paymentsService.recordInsuranceRemittance(
      user.id,
      dto.amountMinor,
      dto.currency,
      dto.reference,
    );
  }

  /** Registra el pago de un crédito a quien alquiló (seña doblada). */
  @Post("admin/ledger/renters/:renterId/compensation")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  renterCompensation(
    @CurrentUser() user: CurrentUserPayload,
    @Param("renterId") renterId: string,
    @Body() dto: LedgerRemittanceDto,
  ) {
    return this.paymentsService.recordRenterCompensationPaid(
      user.id,
      renterId,
      dto.amountMinor,
      dto.currency,
      dto.reference,
    );
  }

  /**
   * El aviso de Stripe. Público, pero verificado por firma contra el cuerpo
   * CRUDO del pedido (express.raw está registrado para esta ruta exacta en
   * app.factory, antes del parser de JSON, así que `req.body` acá es el Buffer
   * sin tocar).
   *
   * Si el cuerpo no es un Buffer, algo se metió en el medio y lo parseó: la
   * firma ya no se puede verificar sobre los bytes originales y reconstruirlo
   * con JSON.stringify daría otros bytes. Antes se reconstruía igual, lo que
   * en el mejor caso fallaba la verificación y en el peor la hacía pasar sobre
   * algo que no era lo que Stripe firmó. Ahora se corta.
   */
  @Post("stripe/webhook")
  handleStripeWebhook(@Req() req: Request) {
    const signature = req.headers["stripe-signature"];
    if (!Buffer.isBuffer(req.body)) {
      throw new Error(
        "El webhook de Stripe llegó con el cuerpo ya parseado: la firma no se " +
          "puede verificar. Revisar el orden de los middlewares en app.factory.",
      );
    }
    return this.paymentsService.handleWebhook(
      req.body,
      Array.isArray(signature) ? signature[0] : signature,
    );
  }
}
