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
import { ReportStatus, UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { CreateReportDto } from "./dto/create-report.dto";
import { ResolveReportDto } from "./dto/resolve-report.dto";
import { ReportsService } from "./reports.service";

@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Cualquier persona con sesión puede reportar. */
  @Post("reports")
  @UseGuards(JwtAuthGuard)
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateReportDto,
  ) {
    return this.reports.create(user.id, dto);
  }

  /** Los reportes que hizo quien consulta, para ver en qué quedaron. */
  @Get("reports/me")
  @UseGuards(JwtAuthGuard)
  listMine(@CurrentUser() user: CurrentUserPayload) {
    return this.reports.listMine(user.id);
  }

  // ── Panel de administración ────────────────────────────────────────────────

  @Get("admin/reports")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  listForAdmin(@Query("status") status?: ReportStatus) {
    return this.reports.listForAdmin(status);
  }

  @Get("admin/reports/open-count")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  countOpen() {
    return this.reports.countOpen().then((open) => ({ open }));
  }

  @Patch("admin/reports/:id/resolve")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  resolve(
    @CurrentUser() admin: CurrentUserPayload,
    @Param("id") id: string,
    @Body() dto: ResolveReportDto,
  ) {
    return this.reports.resolve(admin.id, id, dto);
  }
}
