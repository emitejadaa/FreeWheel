import { Controller, Get, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { ContractsService } from "./contracts.service";

@Controller("contracts")
@UseGuards(JwtAuthGuard)
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get("bookings/:bookingId")
  get(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.contracts.getForParticipant(user.id, bookingId);
  }

  @Post("bookings/:bookingId/accept")
  accept(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.contracts.accept(user.id, bookingId);
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
      "Content-Disposition": `inline; filename="contract-${bookingId}.pdf"`,
      "Content-Length": String(buffer.length),
    });
    res.send(buffer);
  }
}
