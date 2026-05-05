import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import type { CurrentUserPayload } from '../common/types/current-user.type';
import { AdminService } from './admin.service';
import { ReviewVerificationDto } from './dto/review-verification.dto';
import { UpdateListingStatusDto } from './dto/update-listing-status.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users')
  listUsers() {
    return this.adminService.listUsers();
  }

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.adminService.getUser(id);
  }

  @Patch('users/:id/status')
  updateUserStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() updateUserStatusDto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(
      user.id,
      id,
      updateUserStatusDto.status,
    );
  }

  @Patch('users/:id/role')
  updateUserRole(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() updateUserRoleDto: UpdateUserRoleDto,
  ) {
    return this.adminService.updateUserRole(
      user.id,
      id,
      updateUserRoleDto.role,
    );
  }

  @Get('verifications')
  listVerifications() {
    return this.adminService.listVerifications();
  }

  @Get('verifications/:id')
  getVerification(@Param('id') id: string) {
    return this.adminService.getVerification(id);
  }

  @Patch('verifications/:id/review')
  reviewVerification(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() reviewVerificationDto: ReviewVerificationDto,
  ) {
    return this.adminService.reviewVerification(
      user.id,
      id,
      reviewVerificationDto.status,
      reviewVerificationDto.notes,
    );
  }

  @Get('listings')
  listListings() {
    return this.adminService.listListings();
  }

  @Patch('listings/:id/status')
  updateListingStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() updateListingStatusDto: UpdateListingStatusDto,
  ) {
    return this.adminService.updateListingStatus(
      user.id,
      id,
      updateListingStatusDto.status,
    );
  }

  @Get('bookings')
  listBookings() {
    return this.adminService.listBookings();
  }

  @Get('bookings/:id')
  getBooking(@Param('id') id: string) {
    return this.adminService.getBooking(id);
  }
}
