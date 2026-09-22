import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { clientIp, clientUserAgent } from "../common/utils/client-ip.util";
import { ListVehicleVerificationsQueryDto } from "./dto/list-vehicle-verifications-query.dto";
import { ReviewVehicleVerificationDto } from "./dto/review-vehicle-verification.dto";
import { VehicleVerificationService } from "./vehicle-verification.service";

/**
 * La revisión de las verificaciones de autos, del lado del panel.
 *
 * Vive en este módulo y no en src/admin porque la política —qué se puede
 * aprobar, qué se borra al rechazar, qué cuenta como patente duplicada— es de
 * la verificación de vehículos. El panel solo necesita las rutas; si las
 * reglas vivieran en AdminService, cambiarlas obligaría a tocar dos módulos
 * que no saben nada uno del otro.
 */
@Controller("admin/vehicle-verifications")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminVehicleVerificationController {
  constructor(private readonly verification: VehicleVerificationService) {}

  @Get()
  list(@Query() query: ListVehicleVerificationsQueryDto) {
    return this.verification.adminList(query.status);
  }

  /** Datos descifrados y fotos firmadas: cada acceso queda auditado. */
  @Get(":id")
  @Header("Cache-Control", "no-store")
  get(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Req() req: Request,
  ) {
    return this.verification.adminGet(user.id, id, {
      ip: clientIp(req),
      userAgent: clientUserAgent(req),
    });
  }

  @Patch(":id/review")
  review(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() dto: ReviewVehicleVerificationDto,
    @Req() req: Request,
  ) {
    return this.verification.adminReview(user.id, id, dto.status, dto.notes, {
      ip: clientIp(req),
      userAgent: clientUserAgent(req),
    });
  }
}
