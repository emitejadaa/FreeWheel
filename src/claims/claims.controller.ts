import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { DamageClaimStatus, UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { VerifiedAccountGuard } from "../common/guards/verified-account.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { RequireVerifiedAccount } from "../common/decorators/require-verified-account.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { SensitiveRateLimit } from "../common/rate-limit/sensitive-rate-limit.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { ClaimsService } from "./claims.service";
import {
  OpenDamageClaimDto,
  ResolveDamageClaimDto,
  RespondDamageClaimDto,
} from "./dto/damage-claim.dto";

/** Reclamos por daños sobre un auto devuelto. */
@Controller()
@UseGuards(JwtAuthGuard, VerifiedAccountGuard)
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  /** El dueño reclama un daño, dentro de las 48 h de la devolución. */
  @Post("bookings/:bookingId/damage-claim")
  @RequireVerifiedAccount()
  @SensitiveRateLimit({
    name: "claims.open",
    limit: 5,
    windowSec: 3600,
    by: "user",
  })
  open(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Body() dto: OpenDamageClaimDto,
  ) {
    return this.claims.open(user.id, bookingId, dto);
  }

  /** El reclamo de una reserva, para cualquiera de las dos partes. */
  @Get("bookings/:bookingId/damage-claim")
  get(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.claims.getForBooking(user.id, bookingId);
  }

  /** Quien alquiló lo acepta (se cobra del depósito) o lo rechaza. */
  @Post("damage-claims/:claimId/respond")
  @RequireVerifiedAccount()
  respond(
    @CurrentUser() user: CurrentUserPayload,
    @Param("claimId") claimId: string,
    @Body() dto: RespondDamageClaimDto,
  ) {
    return this.claims.respond(user.id, claimId, dto);
  }

  /** El dueño retira el reclamo. */
  @Post("damage-claims/:claimId/withdraw")
  @RequireVerifiedAccount()
  withdraw(
    @CurrentUser() user: CurrentUserPayload,
    @Param("claimId") claimId: string,
  ) {
    return this.claims.withdraw(user.id, claimId);
  }
}

/** La cola de reclamos del panel de administración. */
@Controller("admin/damage-claims")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Get()
  list(@Query("status") status?: DamageClaimStatus) {
    return this.claims.adminList(status);
  }

  /**
   * Resuelve un reclamo rechazado o sin responder. El monto aprobado se cobra
   * del depósito y la reserva se liquida.
   */
  @Patch(":claimId/resolve")
  resolve(
    @CurrentUser() user: CurrentUserPayload,
    @Param("claimId") claimId: string,
    @Body() dto: ResolveDamageClaimDto,
  ) {
    return this.claims.resolve(user.id, claimId, dto);
  }
}
