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
import { MediaCleanupService } from "../media/media-cleanup.service";
import { IdentityDocumentsService } from "../verification/identity/identity-documents.service";
import { DocumentVerificationService } from "../verification/identity/document-verification.service";
import { AccountDeletionPolicy } from "./account-deletion.policy";
import { ReviewsService } from "../reviews/reviews.service";

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly cloudinary: CloudinaryService,
    private readonly identityDocuments: IdentityDocumentsService,
    private readonly documentVerification: DocumentVerificationService,
    private readonly deletionPolicy: AccountDeletionPolicy,
    private readonly reviews: ReviewsService,
    private readonly mediaCleanup: MediaCleanupService,
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

  /**
   * El estado de una cuenta. Es LA forma de sacar a alguien de circulación sin
   * borrarlo: SUSPENDED (baneada) y DELETED (dada de baja) le cierran la puerta
   * —no puede iniciar sesión ni por email ni por Google, y los tokens que ya
   * tenía dejan de valer porque JwtStrategy relee el estado en cada request—
   * pero la fila sigue existiendo, así que su email, su teléfono y su documento
   * quedan tomados y nadie puede registrarse de nuevo con ellos.
   */
  async updateUserStatus(actorId: string, id: string, status: UserStatus) {
    await this.getUser(id);

    // Suspenderse a sí mismo es quedarse afuera del panel en el acto.
    if (actorId === id && status !== UserStatus.ACTIVE) {
      throw new BadRequestException(
        "No podés cambiarle el estado a tu propia cuenta: te quedarías sin " +
          "acceso al panel.",
      );
    }

    const [user, listingsTakenDown] = await this.prisma.$transaction(
      async (tx) => {
        const updated = await tx.user.update({
          where: { id },
          data: { status },
          select: USER_SAFE_SELECT,
        });

        // Sacar a la cuenta de circulación tiene que sacar TAMBIÉN sus avisos:
        // si no, los autos de una cuenta suspendida siguen apareciendo en el
        // buscador y se pueden reservar, y quien reserva no tiene forma de
        // enterarse de que del otro lado no hay nadie.
        //
        // Es el mismo DELETED que usa el dueño cuando borra su propio aviso
        // (DELETE /listings/:id): desaparece del buscador, del detalle y no se
        // puede editar. La fila queda porque de ella cuelgan las reservas, los
        // contratos y los pagos de OTRAS personas, que no se tocan.
        const bajas =
          status === UserStatus.ACTIVE
            ? { count: 0 }
            : await tx.listing.updateMany({
                where: { ownerId: id, status: { not: ListingStatus.DELETED } },
                data: { status: ListingStatus.DELETED },
              });

        return [updated, bajas.count] as const;
      },
    );

    await this.auditLog.create({
      actorId,
      targetUserId: id,
      action: "admin.user.status.update",
      entityType: "User",
      entityId: id,
      metadata: { status, listingsTakenDown },
    });

    // Las fotos y los documentos NO se tocan: la cuenta sigue existiendo y esto
    // se puede revertir. Borrarlos es cosa del borrado definitivo.
    return { ...user, listingsTakenDown };
  }

  /**
   * El rol de una cuenta. Cambiarse el propio está prohibido: no hay alta de
   * admin por API, así que un admin que se saca el rol a sí mismo se queda
   * afuera del panel y hay que devolvérselo a mano en la base. Sacárselo a OTRO
   * admin sí se puede — quien lo hace sigue siendo admin, así que nunca deja el
   * panel sin nadie.
   */
  async updateUserRole(actorId: string, id: string, role: UserRole) {
    await this.getUser(id);

    if (actorId === id) {
      throw new BadRequestException(
        "No podés cambiarte el rol a vos mismo: si te sacás ADMIN te quedás " +
          "sin acceso al panel y no hay forma de recuperarlo desde la API.",
      );
    }
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
        // El contrato referencia a la reserva con Restrict: va primero, o el
        // borrado corta con un error de clave foránea.
        await tx.contract.deleteMany({
          where: { bookingId: { in: bookingIds } },
        });
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

  /**
   * Borra una cuenta DE VERDAD: la fila y todo lo que cuelga de ella.
   *
   * ── Para qué existe ─────────────────────────────────────────────────────
   * Para poder reciclar los datos de una cuenta de demostración —el mismo mail,
   * el mismo teléfono, el mismo DNI— sin tener que inventar una dirección nueva
   * cada vez. Es lo contrario de dar de baja: acá el objetivo es justamente
   * SOLTAR los datos únicos.
   *
   * Por eso mismo está apagado en producción (ver AccountDeletionPolicy): ahí
   * soltar los datos de una cuenta expulsada es dejarla volver a registrarse.
   *
   * ── Por qué hay que borrar tanto a mano ─────────────────────────────────
   * Casi todas las relaciones son `onDelete: Restrict`, que es lo correcto para
   * el día a día —nadie debería poder borrar un usuario y llevarse puestas las
   * reservas de otro sin querer— pero obliga a vaciar en orden: lo que depende
   * de algo va antes que ese algo. Las que son Cascade (favoritos, reseñas,
   * reportes) se van solas y no aparecen acá.
   */
  async deleteUserPermanently(actorId: string, id: string) {
    this.deletionPolicy.assertAllowed();

    // Borrarse a sí mismo deja el panel sin la cuenta desde la que se estaba
    // trabajando. Y como el actor siempre es ADMIN, prohibirlo alcanza para que
    // nunca quede el sistema sin ningún admin: borrar a OTRO admin deja al menos
    // a quien lo borró.
    if (actorId === id) {
      throw new BadRequestException("You cannot delete yourself");
    }

    const user = await this.getUser(id);

    // Se lee ANTES de la transacción porque después las filas ya no están, y
    // sin ellas no hay forma de saber qué archivos había que borrar del
    // storage. Junta las fotos de perfil, las de los autos y los avisos, y los
    // documentos de identidad.
    const ownedMedia = await this.mediaCleanup.collectOwnedMedia(id);

    // Las reseñas que escribió esta persona se van por cascada, y con ellas se
    // mueve el promedio de quien las recibió. Hay que saber a quién antes de
    // que desaparezcan.
    const reviewsWritten = await this.prisma.review.findMany({
      where: { authorId: id },
      select: { targetUserId: true, listingId: true },
    });

    const removed = await this.prisma.$transaction(async (tx) => {
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

      // El contrato de una reserva la referencia con Restrict, así que va
      // ANTES que la reserva. Faltaba: sin esto, borrar una cuenta que hubiera
      // llegado a firmar un contrato fallaba con un error de clave foránea, que
      // es justo el caso de una cuenta de demostración usada de punta a punta.
      await tx.contract.deleteMany({
        where: { bookingId: { in: bookingIds } },
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
      const vehicles = await tx.vehicle.deleteMany({ where: { ownerId: id } });
      await tx.mediaAsset.deleteMany({ where: { ownerId: id } });
      await tx.verificationCode.deleteMany({ where: { userId: id } });
      await tx.documentVerification.deleteMany({ where: { userId: id } });

      // No cuelga del usuario (no tiene FK: se guarda por email, antes de que
      // exista la cuenta), pero si quedó una registración a medio hacer con esta
      // dirección, el mail no está del todo libre. Y el punto de todo esto es
      // que quede libre.
      await tx.pendingRegistration.deleteMany({ where: { email: user.email } });

      await tx.user.delete({ where: { id } });

      return {
        listings: listingIds.length,
        vehicles: vehicles.count,
        bookings: bookingIds.length,
      };
    });

    // Va DESPUÉS de la transacción y sin targetUserId: el usuario ya no existe,
    // y AuditLog lo referencia con Restrict. Es el único rastro que queda de que
    // esta cuenta existió, así que los datos que se liberaron van en metadata.
    await this.auditLog.create({
      actorId,
      action: "admin.user.delete.permanent",
      entityType: "User",
      entityId: id,
      metadata: {
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        removed,
      },
    });

    // Los promedios de las personas y las publicaciones que esta cuenta había
    // reseñado, ahora que esas reseñas ya no están.
    await this.reviews.recalculate(
      reviewsWritten.map((review) => review.targetUserId),
      reviewsWritten
        .map((review) => review.listingId)
        .filter((listingId): listingId is string => listingId !== null),
    );

    // Y recién ahora los archivos del storage: las fotos de perfil, las de los
    // autos y los avisos, y los documentos de identidad.
    //
    // VA DESPUÉS DE LA TRANSACCIÓN a propósito. Borrar en Cloudinary no se
    // deshace, así que si se hiciera adentro y la transacción fallara al final,
    // las filas seguirían en la base apuntando a fotos que ya no existen. Al
    // revés, lo peor que puede pasar es que quede un archivo huérfano ocupando
    // lugar, que no le rompe nada a nadie.
    const media = await this.mediaCleanup.deleteMedia(ownedMedia);

    // Qué quedó libre para volver a usarse. Es el dato que se busca al borrar
    // una cuenta de demostración, así que se contesta en vez de tener que ir a
    // mirar la base.
    return {
      deleted: true,
      user,
      freed: {
        email: user.email,
        phone: user.phone,
      },
      removed: {
        ...removed,
        // Archivos borrados de Cloudinary. `mediaFilesFailed` > 0 significa que
        // quedaron huérfanos (Cloudinary caído o sin credenciales): la cuenta
        // ya no existe igual, pero conviene mirarlo.
        mediaFiles: media.deleted,
        mediaFilesFailed: media.failed,
      },
    };
  }
}
