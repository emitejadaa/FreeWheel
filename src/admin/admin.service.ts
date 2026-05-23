import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ListingStatus,
  UserRole,
  UserStatus,
  VerificationStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../common/services/audit-log.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  listUsers() {
    return this.prisma.user.findMany({
      select: this.safeUserSelect(),
      orderBy: { createdAt: 'desc' },
    });
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: this.safeUserSelect(),
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async updateUserStatus(actorId: string, id: string, status: UserStatus) {
    await this.getUser(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: { status },
      select: this.safeUserSelect(),
    });
    await this.auditLog.create({
      actorId,
      targetUserId: id,
      action: 'admin.user.status.update',
      entityType: 'User',
      entityId: id,
      metadata: { status },
    });
    return user;
  }

  async updateUserRole(actorId: string, id: string, role: UserRole) {
    await this.getUser(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: { role },
      select: this.safeUserSelect(),
    });
    await this.auditLog.create({
      actorId,
      targetUserId: id,
      action: 'admin.user.role.update',
      entityType: 'User',
      entityId: id,
      metadata: { role },
    });
    return user;
  }

  listVerifications() {
    return this.prisma.userVerification.findMany({
      include: { user: { select: this.safeUserSelect() } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getVerification(id: string) {
    const verification = await this.prisma.userVerification.findUnique({
      where: { id },
      include: { user: { select: this.safeUserSelect() } },
    });

    if (!verification) {
      throw new NotFoundException('Verification not found');
    }

    return verification;
  }

  async reviewVerification(
    actorId: string,
    id: string,
    status: VerificationStatus,
    notes?: string,
  ) {
    const verification = await this.getVerification(id);
    if (
      status !== VerificationStatus.VERIFIED &&
      status !== VerificationStatus.REJECTED
    ) {
      throw new BadRequestException(
        'Verification review status must be VERIFIED or REJECTED',
      );
    }
    const reviewedAt = new Date();

    const updated = await this.prisma.userVerification.update({
      where: { id },
      data: { status, notes, reviewedAt },
      include: { user: { select: this.safeUserSelect() } },
    });

    await this.prisma.user.update({
      where: { id: verification.userId },
      data: {
        verificationStatus:
          status === VerificationStatus.VERIFIED
            ? this.resolveApprovedUserStatus(
                verification.user.emailVerifiedAt,
                verification.user.phoneVerifiedAt,
              )
            : VerificationStatus.REJECTED,
      },
    });

    await this.auditLog.create({
      actorId,
      targetUserId: verification.userId,
      action: 'admin.verification.review',
      entityType: 'UserVerification',
      entityId: id,
      metadata: { status },
    });

    return updated;
  }

  listListings() {
    return this.prisma.listing.findMany({
      include: { vehicle: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateListingStatus(actorId: string, id: string, status: ListingStatus) {
    const listing = await this.prisma.listing.findUnique({ where: { id } });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    const updated = await this.prisma.listing.update({
      where: { id },
      data: { status },
      include: { vehicle: true },
    });
    await this.auditLog.create({
      actorId,
      targetUserId: listing.ownerId,
      action: 'admin.listing.status.update',
      entityType: 'Listing',
      entityId: id,
      metadata: { status },
    });
    return updated;
  }

  async deleteListingPermanently(actorId: string, id: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id } });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    const deleted = await this.prisma.$transaction(async (tx) => {
      const bookings = await tx.booking.findMany({
        where: { listingId: id },
        select: { id: true },
      });
      const bookingIds = bookings.map((b) => b.id);

      if (bookingIds.length > 0) {
        await tx.paymentRecord.deleteMany({
          where: { bookingId: { in: bookingIds } },
        });
        await tx.booking.deleteMany({ where: { listingId: id } });
      }

      await tx.listingAvailabilityBlock.deleteMany({ where: { listingId: id } });

      const convs = await tx.conversation.findMany({
        where: { listingId: id },
        select: { id: true },
      });
      if (convs.length > 0) {
        await tx.message.deleteMany({
          where: { conversationId: { in: convs.map((c) => c.id) } },
        });
      }
      await tx.conversation.deleteMany({ where: { listingId: id } });

      return tx.listing.delete({
        where: { id },
        include: { vehicle: true },
      });
    });

    await this.auditLog.create({
      actorId,
      targetUserId: listing.ownerId,
      action: 'admin.listing.delete.permanent',
      entityType: 'Listing',
      entityId: id,
      metadata: { title: listing.title },
    });

    return deleted;
  }

  listBookings() {
    return this.prisma.booking.findMany({
      include: {
        listing: true,
        vehicle: true,
        owner: { select: this.safeUserSelect() },
        renter: { select: this.safeUserSelect() },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getBooking(id: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        listing: true,
        vehicle: true,
        owner: { select: this.safeUserSelect() },
        renter: { select: this.safeUserSelect() },
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    return booking;
  }

  async deleteUserPermanently(actorId: string, id: string) {
    if (actorId === id) {
      throw new BadRequestException('No podés eliminarte a vos mismo');
    }

    await this.getUser(id);

    await this.prisma.$transaction(async (tx) => {
      const listings = await tx.listing.findMany({
        where: { ownerId: id },
        select: { id: true },
      });
      const listingIds = listings.map((l) => l.id);

      const bookings = await tx.booking.findMany({
        where: {
          OR: [
            { ownerId: id },
            { renterId: id },
            { listingId: { in: listingIds } },
          ],
        },
        select: { id: true },
      });
      const bookingIds = bookings.map((b) => b.id);

      await tx.auditLog.deleteMany({
        where: { OR: [{ actorId: id }, { targetUserId: id }] },
      });

      await tx.message.deleteMany({ where: { senderId: id } });

      const convs = await tx.conversation.findMany({
        where: {
          OR: [
            { renterId: id },
            { ownerId: id },
            { listingId: { in: listingIds } },
          ],
        },
        select: { id: true },
      });
      await tx.message.deleteMany({
        where: { conversationId: { in: convs.map((c) => c.id) } },
      });
      await tx.conversation.deleteMany({
        where: {
          OR: [
            { renterId: id },
            { ownerId: id },
            { listingId: { in: listingIds } },
          ],
        },
      });

      await tx.paymentRecord.deleteMany({
        where: {
          OR: [
            { userId: id },
            { bookingId: { in: bookingIds } },
          ],
        },
      });

      await tx.booking.deleteMany({
        where: {
          OR: [
            { ownerId: id },
            { renterId: id },
            { listingId: { in: listingIds } },
          ],
        },
      });

      await tx.listingAvailabilityBlock.deleteMany({
        where: {
          OR: [
            { ownerId: id },
            { listingId: { in: listingIds } },
          ],
        },
      });

      await tx.listing.deleteMany({ where: { ownerId: id } });
      await tx.vehicle.deleteMany({ where: { ownerId: id } });
      await tx.mediaAsset.deleteMany({ where: { ownerId: id } });
      await tx.verificationCode.deleteMany({ where: { userId: id } });
      await tx.userVerification.deleteMany({ where: { userId: id } });

      return tx.user.delete({ where: { id } });
    });

    return { deleted: true };
  }

  private resolveApprovedUserStatus(
    emailVerifiedAt: Date | null,
    phoneVerifiedAt: Date | null,
  ) {
    if (emailVerifiedAt && phoneVerifiedAt) {
      return VerificationStatus.VERIFIED;
    }
    if (emailVerifiedAt) {
      return VerificationStatus.EMAIL_VERIFIED;
    }
    if (phoneVerifiedAt) {
      return VerificationStatus.PHONE_VERIFIED;
    }
    return VerificationStatus.ID_SUBMITTED;
  }

  private safeUserSelect() {
    return {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      displayName: true,
      phone: true,
      profilePhotoUrl: true,
      role: true,
      status: true,
      verificationStatus: true,
      emailVerifiedAt: true,
      phoneVerifiedAt: true,
      createdAt: true,
      updatedAt: true,
    };
  }
}