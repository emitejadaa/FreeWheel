import {
  Body,
  Controller,
  Get,
  Param,
  Post,
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
import { SimulatePaymentDto } from "./dto/simulate-payment.dto";
import { PaymentsService } from "./payments.service";
import type { PaymentContext } from "./payments.service";

/**
 * DE DÓNDE SALIÓ ESTE PEDIDO.
 *
 * La IP y el navegador se guardan con cada cobro. No es telemetría: es lo que
 * permite contestar un desconocimiento de cobro y ver a alguien probando
 * tarjetas robadas desde una misma conexión.
 *
 * `x-forwarded-for` trae la cadena de proxies y el PRIMERO es el cliente. Se
 * toma ese y no `req.ip`, que detrás del proxy de Vercel es siempre la IP del
 * proxy — o sea, la misma para todo el mundo, que no sirve para nada.
 */
function contextOf(req: Request, actorId?: string): PaymentContext {
  const forwarded = req.headers["x-forwarded-for"];
  const cadena = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = cadena?.split(",")[0]?.trim() || req.ip || null;
  const userAgent = req.headers["user-agent"] ?? null;
  return { actorId: actorId ?? null, ip, userAgent };
}

// Toda acción de pago exige una cuenta verificada, con el DNI vigente. El
// webhook de Stripe queda público: se autentica por firma.
@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * Los límites de acá son más bajos que el general del servidor, y no es por
   * costo: crear intents contra un procesador es la forma barata de probar
   * tarjetas robadas de a cientos, y un límite es lo único que la frena.
   */
  @Throttle({ default: { limit: 20, ttl: 600_000 } })
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

  @Throttle({ default: { limit: 20, ttl: 600_000 } })
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
