import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Throttle } from "@nestjs/throttler";
import { UserRole } from "@prisma/client";
import type { Request, Response } from "express";
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
import { ProcessorErrorFilter } from "./filters/processor-error.filter";
import { CardPaymentDto, cardInputFrom } from "./dto/card-payment.dto";
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

// Toda acción de pago exige una cuenta verificada, con el DNI vigente. Los
// avisos de Mercado Pago y la vuelta del OAuth quedan públicos: se autentican
// por firma y por el `state` cifrado, respectivamente.
//
// EL FILTRO HACE QUE UN ERROR DE MERCADO PAGO DIGA QUÉ PASÓ en vez de un 500
// mudo. Ver filters/processor-error.filter.ts.
@UseFilters(ProcessorErrorFilter)
@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * LO QUE EL FRONT NECESITA PARA ARMAR EL FORMULARIO DE PAGO: la clave
   * pública DEL DUEÑO (la tarjeta se tokeniza con la clave de la cuenta que
   * cobra), el importe y el ticket.
   */
  @Get("bookings/:bookingId/checkout")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  getCheckoutConfig(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.getCheckoutConfig(user.id, bookingId);
  }

  /**
   * EL PAGO DE LA RESERVA: alquiler + cobertura, de una sola vez, con la
   * tarjeta que tokenizó el formulario de Mercado Pago. Exige que quien
   * alquila haya aceptado el contrato (409 CONTRACT_NOT_ACCEPTED).
   *
   * Los límites son más bajos que el general del servidor, y no es por costo:
   * mandar pagos contra un procesador es la forma barata de probar tarjetas
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
    @Body() dto: CardPaymentDto,
    @Req() req: Request,
  ) {
    return this.paymentsService.createCheckout(
      user.id,
      bookingId,
      contextOf(req, user.id),
      cardInputFrom(dto),
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

  /** DEPRECADO: alias del cobro único, con el mismo cuerpo. */
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
    @Body() dto: CardPaymentDto,
    @Req() req: Request,
  ) {
    return this.paymentsService.createSenaIntent(
      user.id,
      bookingId,
      contextOf(req, user.id),
      cardInputFrom(dto),
    );
  }

  /** DEPRECADO: el pago es uno solo (409 PAYMENT_IS_SINGLE). */
  @Post("bookings/:bookingId/balance-intent")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  createBalanceIntent() {
    return this.paymentsService.createBalanceIntent();
  }

  /**
   * AUTORIZAR EL DEPÓSITO EN GARANTÍA: una reserva de fondos en la tarjeta,
   * con quien alquila presente. Se habilita cerca del retiro (una reserva de
   * fondos vale 7 días); antes contesta 409 DEPOSIT_TOO_EARLY con la fecha.
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
    @Body() dto: CardPaymentDto,
    @Req() req: Request,
  ) {
    return this.paymentsService.createDepositHold(
      user.id,
      bookingId,
      contextOf(req, user.id),
      cardInputFrom(dto),
    );
  }

  /**
   * LAS TARJETAS GUARDADAS. Con el split de Mercado Pago no hay (ver el
   * servicio): la ruta queda para que el front que la llamaba no se rompa.
   */
  @Get("methods")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  listSavedCards(@CurrentUser() user: CurrentUserPayload) {
    return this.paymentsService.listSavedCards(user.id);
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

  /**
   * VINCULAR LA CUENTA DE MERCADO PAGO DEL DUEÑO: devuelve la URL a la que
   * hay que mandarlo. Mercado Pago lo trae de vuelta a
   * /payments/mercadopago/oauth/callback, y de ahí al front.
   */
  @Post("connect/onboarding")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  @SensitiveRateLimit({
    name: "payments.connect",
    limit: 10,
    windowSec: 600,
    by: "user",
  })
  createOnboarding(@CurrentUser() user: CurrentUserPayload) {
    return this.paymentsService.createOwnerOnboarding(user.id);
  }

  /** Si este dueño ya puede cobrar. */
  @Get("connect/status")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  getConnectStatus(@CurrentUser() user: CurrentUserPayload) {
    return this.paymentsService.getOwnerPayoutStatus(user.id);
  }

  /** Desvincular la cuenta. No se puede con cobros sin cerrar. */
  @Delete("connect")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  unlink(@CurrentUser() user: CurrentUserPayload) {
    return this.paymentsService.unlinkOwner(user.id);
  }

  /**
   * LA VUELTA DEL OAUTH DE MERCADO PAGO.
   *
   * La hace el navegador del dueño, sin la sesión de FreeWheel: lo único que
   * dice quién es la persona es el `state` cifrado. Termina siempre en una
   * redirección al front (con `?status=ok` o `?status=error&code=…`), nunca
   * en un JSON: quien la ve es una persona, no el front.
   */
  @Get("mercadopago/oauth/callback")
  @SensitiveRateLimit({
    name: "payments.oauth-callback",
    limit: 20,
    windowSec: 600,
    by: "ip",
  })
  async oauthCallback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Res() res: Response,
  ) {
    const destino = await this.paymentsService.completeOwnerOnboarding({
      code,
      state,
      error,
    });
    res.redirect(302, destino);
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
   * Registra una transferencia a un dueño de un saldo que el split no le
   * podía dar (el ajuste de una cancelación con seña).
   */
  @Post("admin/ledger/owners/:ownerId/payout")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  ownerPayout(
    @CurrentUser() user: CurrentUserPayload,
    @Param("ownerId") ownerId: string,
    @Body() dto: LedgerRemittanceDto,
  ) {
    return this.paymentsService.recordOwnerPayoutPaid(
      user.id,
      ownerId,
      dto.amountMinor,
      dto.currency,
      dto.reference,
    );
  }

  /** Reintenta la devolución de una cancelación que quedó sin hacerse. */
  @Post("admin/bookings/:bookingId/retry-refund")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  retryRefund(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.retryCancellation(user.id, bookingId);
  }

  /**
   * VOLVER A LIQUIDAR UNA RESERVA DEVUELTA Y SIN LIQUIDAR.
   *
   * Solo un administrador, por lo mismo que la captura del depósito: mueve
   * plata entre dos personas.
   *
   * Existe porque la devolución del auto no se cae cuando la liquidación
   * falla: el auto volvió igual, y lo que falta es plata. Sin esto, una
   * reserva que quedó devuelta con el depósito todavía retenido y el dueño sin
   * cobrar no tenía forma de arreglarse, porque confirmar la devolución otra
   * vez ya no se puede.
   */
  @Post("bookings/:bookingId/settle")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  settle(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.paymentsService.resettle(user.id, bookingId);
  }

  /**
   * LOS AVISOS DE MERCADO PAGO. Públicos, pero verificados por firma
   * (x-signature, HMAC con MP_WEBHOOK_SECRET). Y aun firmados son solo una
   * pista: el estado de cada cobro se le pregunta a la API.
   *
   * Contesta 200 rápido: Mercado Pago reintenta lo que no se contesta, y un
   * aviso que se procesa dos veces no hace nada la segunda (la unicidad del
   * id lo descarta).
   */
  @Post("mercadopago/webhook")
  @HttpCode(200)
  @SkipThrottle()
  handleMercadoPagoWebhook(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
  ) {
    return this.paymentsService.handleNotification({ headers, query, body });
  }
}
