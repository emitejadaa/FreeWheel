import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { VerifiedAccountGuard } from "../common/guards/verified-account.guard";
import { RequireVerifiedAccount } from "../common/decorators/require-verified-account.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { ClaimsService } from "./claims.service";
import { CreateDamageClaimDto } from "./dto/create-damage-claim.dto";
import { ResolveDamageClaimDto } from "./dto/resolve-damage-claim.dto";

/**
 * El reclamo de un daño sobre el depósito en garantía.
 *
 * El dueño reclama, un administrador resuelve, el dueño no cobra nunca solo:
 * es plata de otra persona y las dos partes tienen intereses opuestos
 * justamente acá. Ver claims.service.ts.
 */
@Controller()
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  /**
   * En qué anda la revisión de esta reserva: si el dueño todavía puede
   * reclamar, hasta cuándo, y los reclamos que haya.
   *
   * Lo ven las dos partes. Al inquilino le sirve para entender por qué su
   * garantía sigue retenida, que es la pregunta que si no termina en soporte.
   */
  @Get("bookings/:bookingId/damage")
  @UseGuards(JwtAuthGuard)
  estado(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.claims.estadoDeLaReserva(user.id, bookingId);
  }

  /** El dueño abre el reclamo, con fotos y un importe. */
  @Post("bookings/:bookingId/damage")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  crear(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
    @Body() dto: CreateDamageClaimDto,
  ) {
    return this.claims.crear(user.id, bookingId, dto);
  }

  /**
   * "Está todo bien": el dueño revisó el auto y suelta la garantía sin esperar
   * a que venza el plazo. Es el camino normal.
   */
  @Post("bookings/:bookingId/inspection-ok")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  todoBien(
    @CurrentUser() user: CurrentUserPayload,
    @Param("bookingId") bookingId: string,
  ) {
    return this.claims.todoBien(user.id, bookingId);
  }

  /** Los reclamos sin resolver, para el panel. */
  @Get("admin/damage-claims")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  listarAbiertos() {
    return this.claims.listarAbiertos();
  }

  /** Aceptar (cobra del depósito) o rechazar (libera la garantía entera). */
  @Post("admin/damage-claims/:claimId/resolve")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  resolver(
    @CurrentUser() user: CurrentUserPayload,
    @Param("claimId") claimId: string,
    @Body() dto: ResolveDamageClaimDto,
  ) {
    return this.claims.resolver(user.id, claimId, dto);
  }
}
