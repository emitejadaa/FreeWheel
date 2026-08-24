import { BadRequestException, Injectable } from "@nestjs/common";
import {
  DocumentVerificationStatus,
  ListingStatus,
  UserRole,
  UserStatus,
  VerifiedDocumentType,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../common/services/audit-log.service";
import { assertFound } from "../common/utils/entity.util";
import { USER_SAFE_SELECT } from "../common/constants/prisma-select";
import { CloudinaryService } from "../media/cloudinary.service";
import { IdentityDocumentsService } from "../verification/identity/identity-documents.service";
import { DocumentVerificationService } from "../verification/identity/document-verification.service";

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly cloudinary: CloudinaryService,
    private readonly identityDocuments: IdentityDocumentsService,
    private readonly documentVerification: DocumentVerificationService,
  ) {}

  listUsers() {
    return this.prisma.user.findMany({
      select: USER_SAFE_SELECT,
      orderBy: { createdAt: "desc" },
    });
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: USER_SAFE_SELECT,
    });
    assertFound(user, "User not found");

    return user;
  }

  async updateUserStatus(actorId: string, id: string, status: UserStatus) {
    await this.getUser(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: { status },
      select: USER_SAFE_SELECT,
    });
    await this.auditLog.create({
      actorId,
      targetUserId: id,
      action: "admin.user.status.update",
      entityType: "User",
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
      select: USER_SAFE_SELECT,
    });
    await this.auditLog.create({
      actorId,
      targetUserId: id,
      action: "admin.user.role.update",
      entityType: "User",
      entityId: id,
      metadata: { role },
    });
    return user;
  }

  /**
   * Verificaciones documentales, filtrables por estado y tipo. Sin filtros
   * lista todo; con status=MANUAL_REVIEW es la cola de casos que esperan a
   * un admin (pedidos por el propio usuario).
   */
  listVerifications(filters: { status?: string; type?: string } = {}) {
    const status = Object.values(DocumentVerificationStatus).find(
      (value) => value === filters.status,
    );
    const type = Object.values(VerifiedDocumentType).find(
      (value) => value === filters.type,
    );

    return this.prisma.documentVerification.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
      },
      include: { user: { select: USER_SAFE_SELECT } },
      orderBy: { updatedAt: "desc" },
    });
  }

  async getVerification(id: string) {
    const verification = await this.prisma.documentVerification.findUnique({
      where: { id },
      include: { user: { select: USER_SAFE_SELECT } },
    });
    assertFound(verification, "Verification not found");

    return verification;
  }

  /**
   * Documentos de una verificación para que un admin los revise a mano. Los
   * assets son privados (type=authenticated): se generan URLs firmadas al
   * momento, que nunca se persisten ni se exponen al titular. Cada acceso
   * queda auditado porque implica ver datos personales sensibles.
   */
  async getVerificationDocuments(actorId: string, id: string) {
    const verification = await this.getVerification(id);

    const signedUrl = (url: string | null) => {
      if (!url) return null;
      const asset = this.identityDocuments.parsePersistedUrl(url);
      if (!asset) return null;
      return this.cloudinary.signedDeliveryUrl(asset.publicId, {
        format: asset.format,
      });
    };

    await this.auditLog.create({
      actorId,
      targetUserId: verification.userId,
      action: "admin.verification.documents.view",
      entityType: "DocumentVerification",
      entityId: id,
    });

    return {
      id: verification.id,
      userId: verification.userId,
      type: verification.type,
      status: verification.status,
      documents: {
        front: signedUrl(verification.frontUrl),
        back: signedUrl(verification.backUrl),
      },
      extracted: verification.extracted,
      matchReport: verification.matchReport,
      notes: verification.notes,
    };
  }

  /**
   * Veredicto manual: APPROVED aprueba el documento (y puede dejar la
   * cuenta VERIFIED si el otro también lo está); REJECTED borra los
   * archivos del storage. La política vive en DocumentVerificationService.
   */
  async reviewVerification(
    actorId: string,
    id: string,
    status: "APPROVED" | "REJECTED",
    notes?: string,
  ) {
    const updated = await this.documentVerification.adminReview(
      actorId,
      id,
      status,
      notes,
    );

    const user = await this.prisma.user.findUnique({
      where: { id: updated.userId },
      select: USER_SAFE_SELECT,
    });

    return { ...updated, user };
  }

  listListings() {
    return this.prisma.listing.findMany({
      include: { vehicle: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async updateListingStatus(
    actorId: string,
    id: string,
    status: ListingStatus,
  ) {
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    assertFound(listing, "Listing not found");

    const updated = await this.prisma.listing.update({
      where: { id },
      data: { status },
      include: { vehicle: true },
    });
    await this.auditLog.create({
      actorId,
      targetUserId: listing.ownerId,
      action: "admin.listing.status.update",
      entityType: "Listing",
      entityId: id,
      metadata: { status },
    });
    return updated;
  }

  async deleteListingPermanently(actorId: string, id: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    assertFound(listing, "Listing not found");

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

      await tx.listingAvailabilityBlock.deleteMany({
        where: { listingId: id },
      });

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
      action: "admin.listing.delete.permanent",
      entityType: "Listing",
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
        owner: { select: USER_SAFE_SELECT },
        renter: { select: USER_SAFE_SELECT },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async getBooking(id: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        listing: true,
        vehicle: true,
        owner: { select: USER_SAFE_SELECT },
        renter: { select: USER_SAFE_SELECT },
      },
    });
    assertFound(booking, "Booking not found");

    return booking;
  }

  async deleteUserPermanently(actorId: string, id: string) {
    const identityDocumentUrls =
      await this.prisma.documentVerification.findMany({
        where: { userId: id },
        select: { frontUrl: true, backUrl: true },
      });

    if (actorId === id) {
      throw new BadRequestException("You cannot delete yourself");
    }

    await this.getUser(id);

    // FK relations use onDelete: Restrict, so every dependent row must be
    // removed before the user. Order matters: messages and payment records
    // first, then conversations/bookings/blocks, then the owned listings,
    // vehicles, media, and verification rows, and finally the user itself.
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
          OR: [{ userId: id }, { bookingId: { in: bookingIds } }],
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
          OR: [{ ownerId: id }, { listingId: { in: listingIds } }],
        },
      });

      await tx.listing.deleteMany({ where: { ownerId: id } });
      await tx.vehicle.deleteMany({ where: { ownerId: id } });
      await tx.mediaAsset.deleteMany({ where: { ownerId: id } });
      await tx.verificationCode.deleteMany({ where: { userId: id } });
      await tx.documentVerification.deleteMany({ where: { userId: id } });

      return tx.user.delete({ where: { id } });
    });

    // Los documentos de identidad no deben quedar huérfanos en el storage:
    // se borran después de la transacción (best-effort, registrado en log).
    await this.identityDocuments.deleteDocuments(
      identityDocumentUrls.flatMap((row) => [row.frontUrl, row.backUrl]),
    );

    return { deleted: true };
  }
}
