import {
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { VerifiedAccountGuard } from "../common/guards/verified-account.guard";
import { RequireVerifiedAccount } from "../common/decorators/require-verified-account.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { clientIp, clientUserAgent } from "../common/utils/client-ip.util";
import { ContractsService } from "./contracts.service";

@Controller("contracts")
@UseGuards(JwtAuthGuard, VerifiedAccountGuard)
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  /**
   * Las cláusulas vigentes, para mostrarlas ANTES de aceptar una reserva. El
   * dueño acepta el contrato al aceptar la reserva, así que tiene que haberlas
   * visto antes de apretar el botón.
   */
  @Get("template")
  template() {
    return this.contracts.template();
  }

  @Get("bookings/:bookingId")
  get(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.contracts.getForParticipant(user.id, bookingId);
  }

  @Post("bookings/:bookingId/accept")
  @RequireVerifiedAccount()
  accept(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Req() req: Request,
  ) {
    return this.contracts.accept(user.id, bookingId, {
      ip: clientIp(req),
      userAgent: clientUserAgent(req),
    });
  }

  @Get("bookings/:bookingId/pdf")
  async pdf(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.contracts.renderPdf(user.id, bookingId);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="contrato-${bookingId}.pdf"`,
      "Content-Length": String(buffer.length),
      // Es un documento con datos personales de dos personas: que ningún
      // proxy ni el navegador lo guarde en un caché compartido.
      "Cache-Control": "private, no-store",
    });
    res.send(buffer);
  }
}
