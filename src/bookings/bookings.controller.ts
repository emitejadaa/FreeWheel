import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { VerifiedAccountGuard } from "../common/guards/verified-account.guard";
import { RequireVerifiedAccount } from "../common/decorators/require-verified-account.decorator";
import { RequireDrivingEligibility } from "../common/decorators/require-driving-eligibility.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { SensitiveRateLimit } from "../common/rate-limit/sensitive-rate-limit.decorator";
import { clientIp, clientUserAgent } from "../common/utils/client-ip.util";
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

  /**
   * Pedir un auto es el momento en que alguien se compromete a manejarlo, así
   * que es acá donde se controla que pueda: licencia vigente, de una clase que
   * sirva para un auto y fuera del período de principiante.
   *
   * Se controla ACÁ y no también en los pagos a propósito. Un cobro es de una
   * reserva que ya existe, y esa reserva ya pasó por este control; repetirlo
   * más adelante solo lograría dejar a alguien con una reserva aceptada que no
   * puede terminar de pagar porque su licencia venció en el medio. Eso no es
   * un fraude que haya que frenar, es un problema de atención al cliente que
   * nos estaríamos creando solos.
   */
  @Post()
  @RequireVerifiedAccount()
  @RequireDrivingEligibility()
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

  /**
   * Aceptar es firmar. Se guarda desde qué IP y con qué navegador se aceptó,
   * porque el día que alguien diga "yo nunca acepté eso" esa es la única
   * prueba que tenemos (ley 25.506: la carga de probar la firma es de quien
   * la invoca, y quien la invoca vamos a ser nosotros).
   */
  @Patch(":id/accept")
  @RequireVerifiedAccount()
  accept(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Req() req: Request,
  ) {
    return this.bookingsService.accept(user.id, id, {
      ip: clientIp(req),
      userAgent: clientUserAgent(req),
    });
  }

  @Patch(":id/reject")
  @RequireVerifiedAccount()
  reject(@CurrentUser() user: CurrentUserPayload, @Param("id") id: string) {
    return this.bookingsService.reject(user.id, id);
  }

  /**
   * Cuánto se devuelve si cancelo ahora, sin cancelar. Se consulta antes de
   * apretar el botón: nadie debería enterarse de que perdió la seña después
   * de perderla.
   */
  @Get(":id/cancellation-preview")
  cancellationPreview(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
  ) {
    return this.bookingsService.cancellationPreview(user.id, id);
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

  /**
   * Cerrar la reserva a mano cuando ya pasaron las 48 horas y nadie reclamó:
   * suelta el depósito y le paga al dueño. Lo puede pedir cualquiera de las
   * dos partes y es idempotente, porque el trabajo programado hace lo mismo
   * una vez por día y los dos pueden llegar juntos.
   */
  @Post(":id/settle")
  @RequireVerifiedAccount()
  @SensitiveRateLimit({
    name: "bookings.settle",
    limit: 20,
    windowSec: 600,
    by: "ip+user",
  })
  settle(@CurrentUser() user: CurrentUserPayload, @Param("id") id: string) {
    return this.bookingsService.settle(user.id, id);
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
