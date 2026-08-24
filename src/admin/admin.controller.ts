import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { AdminService } from "./admin.service";
import { AccountDeletionPolicy } from "./account-deletion.policy";
import { ReviewVerificationDto } from "./dto/review-verification.dto";
import { UpdateListingStatusDto } from "./dto/update-listing-status.dto";
import { UpdateUserRoleDto } from "./dto/update-user-role.dto";
import { UpdateUserStatusDto } from "./dto/update-user-status.dto";

@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly deletionPolicy: AccountDeletionPolicy,
  ) {}

  /**
   * Qué puede hacer el panel en ESTE servidor. Hoy una sola cosa: si borrar
   * cuentas de verdad está habilitado (en producción no lo está).
   *
   * Existe para que el panel no muestre un botón que va a contestar 403. Un
   * botón que falla siempre es peor que un botón que no está.
   */
  @Get("settings")
  settings() {
    return {
      hardDeleteAccounts: this.deletionPolicy.enabled,
      hardDeleteDisabledReason: this.deletionPolicy.enabled
        ? null
        : AccountDeletionPolicy.BLOCKED_MESSAGE,
    };
  }

  @Get("users")
  listUsers() {
    return this.adminService.listUsers();
  }

  @Get("users/:id")
  getUser(@Param("id") id: string) {
    return this.adminService.getUser(id);
  }

  @Patch("users/:id/status")
  updateUserStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(user.id, id, dto.status);
  }

  @Patch("users/:id/role")
  updateUserRole(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.adminService.updateUserRole(user.id, id, dto.role);
  }

  @Get("verifications")
  listVerifications(
    @Query("status") status?: string,
    @Query("type") type?: string,
  ) {
    return this.adminService.listVerifications({ status, type });
  }

  @Get("verifications/:id")
  getVerification(@Param("id") id: string) {
    return this.adminService.getVerification(id);
  }

  @Get("verifications/:id/documents")
  getVerificationDocuments(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
  ) {
    return this.adminService.getVerificationDocuments(user.id, id);
  }

  @Patch("verifications/:id/review")
  reviewVerification(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() dto: ReviewVerificationDto,
  ) {
    return this.adminService.reviewVerification(
      user.id,
      id,
      dto.status,
      dto.notes,
    );
  }

  @Get("listings")
  listListings() {
    return this.adminService.listListings();
  }

  @Patch("listings/:id/status")
  updateListingStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() dto: UpdateListingStatusDto,
  ) {
    return this.adminService.updateListingStatus(user.id, id, dto.status);
  }

  @Delete("listings/:id")
  deleteListingPermanently(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
  ) {
    return this.adminService.deleteListingPermanently(user.id, id);
  }

  @Get("bookings")
  listBookings() {
    return this.adminService.listBookings();
  }

  @Get("bookings/:id")
  getBooking(@Param("id") id: string) {
    return this.adminService.getBooking(id);
  }

  /**
   * Borra una cuenta DEFINITIVAMENTE, con todo lo que cuelga de ella, y libera
   * sus datos únicos (email, teléfono, documento) para volver a usarlos. Es
   * para armar cuentas de demostración durante el desarrollo.
   *
   * En producción contesta 403: ahí una cuenta se saca de circulación con
   * PATCH /admin/users/:id/status (SUSPENDED o DELETED), que le cierra la
   * puerta SIN soltar sus datos. Ver AccountDeletionPolicy.
   */
  @Delete("users/:id")
  deleteUserPermanently(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
  ) {
    return this.adminService.deleteUserPermanently(user.id, id);
  }
}
