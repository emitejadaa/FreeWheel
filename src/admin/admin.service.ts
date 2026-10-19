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
import { BookingsService } from "../bookings/bookings.service";
import type { LadoDelNoShow } from "../bookings/cancellation-policy";
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
    private readonly bookings: BookingsService,
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
      // LO QUE LA PERSONA DECLARÓ, que es contra lo que hay que mirar la foto.
      //
      // Sin esto el panel mostraba las fotos y los motivos del veredicto, pero
      // no el dato que se estaba discutiendo: quien revisa tenía que adivinar
      // si el problema era que la foto se leía mal o que el vencimiento
      // cargado no era el que dice el documento. Son las dos mitades de la
      // misma decisión y tienen que verse juntas.
      declared: verification.declared,
      // El resultado del cruce campo por campo, SIN los valores leídos (ver
      // DocumentVerification.checks): dice qué coincidió y qué no, y sobre qué
      // foto, que es lo que orienta la mirada.
      checks: verification.checks,
      matchReport: verification.matchReport,
      reasonCodes: verification.reasonCodes,
      retakeSlots: verification.retakeSlots,
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
        // Todo lo que apunta a la reserva con Restrict, antes que la reserva:
        // firmas del contrato, el contrato, el reclamo por daños, los asientos
        // contables y el registro de cada cobro. Si falta uno, el borrado
        // corta con un error de clave foránea a mitad de camino.
        const contratos = await tx.contract.findMany({
          where: { bookingId: { in: bookingIds } },
          select: { id: true },
        });
        await tx.contractAcceptance.deleteMany({
          where: { contractId: { in: contratos.map((c) => c.id) } },
        });
        await tx.contract.deleteMany({
          where: { bookingId: { in: bookingIds } },
        });
        await tx.damageClaim.deleteMany({
          where: { bookingId: { in: bookingIds } },
        });
        const asientos = await tx.ledgerJournal.findMany({
          where: { bookingId: { in: bookingIds } },
          select: { id: true },
        });
        await tx.ledgerEntry.deleteMany({
          where: { journalId: { in: asientos.map((a) => a.id) } },
        });
        await tx.ledgerJournal.deleteMany({
          where: { bookingId: { in: bookingIds } },
        });
        await tx.paymentEvent.deleteMany({
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

  /**
   * CANCELAR UNA RESERVA DEVOLVIENDO TODO, DESDE EL PANEL.
   *
   * Es la válvula de último recurso, y conviene decir qué NO es: no es cómo se
   * resuelven los casos normales. El que no aparece ya no cobra sin que nadie
   * intervenga, y el dueño que sí fue tiene su propio reporte; los dos caminos
   * están en bookings/cancellation-policy.ts y no pasan por acá.
   *
   * Esto queda para lo que ninguna regla puede prever: el auto que se rompió
   * camino a la entrega, el reclamo que llegó por otro lado, el caso raro. Sin
   * una salida así, un caso raro no tiene arreglo posible y termina en una
   * transferencia por fuera del sistema, que es peor para todos.
   *
   * Se cancela EN NOMBRE DE QUIEN ALQUILA y no del dueño, a propósito: la
   * cancelación del dueño existe para que él se pueda bajar, y usarla desde el
   * panel registraría que se bajó alguien que no fue. El resultado para la
   * plata es el mismo —vuelve todo—, pero el registro dice la verdad.
   *
   * Queda en el registro de auditoría con el nombre del administrador y el
   * motivo, que es obligatorio: una devolución total sin motivo escrito es
   * justo lo que nadie va a poder explicar después.
   */
  async cancelBookingWithFullRefund(
    adminId: string,
    bookingId: string,
    reason: string,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, renterId: true },
    });
    assertFound(booking, "Booking not found");

    const resultado = await this.bookings.cancel(booking.renterId, bookingId, {
      reason: `Cancelada por un administrador: ${reason}`,
    });

    await this.auditLog.create({
      actorId: adminId,
      targetUserId: booking.renterId,
      action: "admin.booking_cancelled_full_refund",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { reason },
    });

    return resultado;
  }

  /**
   * LOS RETIROS QUE NO PASARON Y QUEDARON TRABADOS.
   *
   * Las dos partes dejaron constancia de que la otra no apareció. La plata está
   * quieta y la cancelación no corre hasta que alguien decida cuál versión
   * vale. Esto es esa bandeja.
   *
   * ── LO QUE VIENE CON CADA CASO, Y POR QUÉ ────────────────────────────────
   * Las dos versiones con su hora, la reserva con sus fechas e importes, y —lo
   * que de verdad ayuda a decidir— EL HISTORIAL DE CADA UNO: cuántas veces esa
   * persona reclamó un no-show y cuántas veces se lo reclamaron.
   *
   * Un caso aislado es la palabra de uno contra la del otro y no hay con qué
   * resolverlo. Un dueño con ocho reclamos en dos meses no es un caso aislado,
   * y ese patrón solo se ve mirando TODAS sus reservas, que es algo que la
   * persona que decide no puede hacer a mano. Es también lo que hace que esto
   * sirva igual el día que quien mire no sea una persona: el caso ya llega con
   * las dos versiones y con la señal de reincidencia calculada.
   *
   * Los casos ya resueltos no aparecen: esto es una bandeja de pendientes.
   */
  async listNoShowDisputes() {
    const trabadas = await this.prisma.booking.findMany({
      where: {
        renterNoShowAt: { not: null },
        ownerNoShowAt: { not: null },
        noShowResolvedFor: null,
      },
      include: {
        vehicle: true,
        owner: { select: USER_SAFE_SELECT },
        renter: { select: USER_SAFE_SELECT },
      },
      orderBy: { startDate: "asc" },
    });

    /*
      El historial se cuenta de una sola vez para todas las personas de la
      bandeja, no de a una por caso: con veinte casos abiertos serían ochenta
      consultas para mostrar una pantalla.
    */
    const personas = [
      ...new Set(trabadas.flatMap((b) => [b.ownerId, b.renterId])),
    ];
    const [reclamosDeDuenos, reclamosDeInquilinos] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ["ownerId"],
        where: { ownerId: { in: personas }, renterNoShowAt: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.booking.groupBy({
        by: ["renterId"],
        where: { renterId: { in: personas }, ownerNoShowAt: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const comoDueno = new Map(
      reclamosDeDuenos.map((r) => [r.ownerId, r._count._all]),
    );
    const comoInquilino = new Map(
      reclamosDeInquilinos.map((r) => [r.renterId, r._count._all]),
    );

    return trabadas.map((booking) => ({
      booking,
      /** Las dos versiones, con su hora. */
      elDuenoReportoA: booking.renterNoShowAt,
      quienAlquiloReportoA: booking.ownerNoShowAt,
      /** Quién habló primero. No decide nada, pero es un dato del caso. */
      reportoPrimero:
        booking.renterNoShowAt && booking.ownerNoShowAt
          ? booking.renterNoShowAt <= booking.ownerNoShowAt
            ? "OWNER"
            : "RENTER"
          : null,
      historial: {
        /** Cuántas veces este dueño reclamó que no le fueron a retirar. */
        reclamosDelDueno: comoDueno.get(booking.ownerId) ?? 0,
        /** Cuántas veces a este dueño le reclamaron no haber entregado. */
        reclamosContraElDueno: comoInquilino.get(booking.ownerId) ?? 0,
        /** Lo mismo del otro lado. */
        reclamosDeQuienAlquilo: comoInquilino.get(booking.renterId) ?? 0,
        reclamosContraQuienAlquilo: comoDueno.get(booking.renterId) ?? 0,
      },
    }));
  }

  /**
   * RESUELVE UN CASO TRABADO Y CIERRA LA RESERVA.
   *
   * Dos cosas pasan acá, en este orden:
   *
   *  1. Se guarda a favor de quién se decidió. NO se borra la constancia que
   *     pierde: sigue siendo un dato sobre quien la hizo, y un reclamo que se
   *     cae una y otra vez es exactamente el patrón que hay que poder ver.
   *  2. Se cancela. Con el caso resuelto la política vuelve a decidir sola: a
   *     favor del dueño, la seña queda para él (fue y esperó); a favor de quien
   *     alquiló, vuelve todo.
   *
   * Lo que NO hace es inventar un reparto propio. La decisión humana es sobre
   * UN hecho —quién fue— y de ahí en adelante manda la misma regla escrita que
   * en cualquier otra reserva. Un admin que además pudiera elegir los importes
   * sería una tercera política sin pruebas y sin texto que la explique.
   */
  async resolveNoShowDispute(
    adminId: string,
    bookingId: string,
    aFavorDe: LadoDelNoShow,
    reason: string,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        renterId: true,
        ownerId: true,
        renterNoShowAt: true,
        ownerNoShowAt: true,
        noShowResolvedFor: true,
      },
    });
    assertFound(booking, "Booking not found");

    if (!booking.renterNoShowAt || !booking.ownerNoShowAt) {
      throw new BadRequestException({
        statusCode: 400,
        code: "NO_SHOW_NOT_DISPUTED",
        message:
          "Esta reserva no tiene dos versiones enfrentadas: no hay nada que " +
          "resolver. Si hay que cancelarla igual, es la cancelación con " +
          "devolución total.",
      });
    }
    if (booking.noShowResolvedFor) {
      throw new BadRequestException({
        statusCode: 400,
        code: "NO_SHOW_ALREADY_RESOLVED",
        message: "Este caso ya lo resolvió alguien.",
      });
    }

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { noShowResolvedFor: aFavorDe },
    });

    await this.auditLog.create({
      actorId: adminId,
      targetUserId: aFavorDe === "OWNER" ? booking.ownerId : booking.renterId,
      action: "admin.no_show_dispute_resolved",
      entityType: "Booking",
      entityId: bookingId,
      metadata: {
        aFavorDe,
        reason,
        elDuenoReportoA: booking.renterNoShowAt.toISOString(),
        quienAlquiloReportoA: booking.ownerNoShowAt.toISOString(),
      },
    });

    /*
      La cancelación va EN NOMBRE DE QUIEN ALQUILÓ, igual que la cancelación
      administrativa con devolución total, y por el mismo motivo: así el
      registro no dice que canceló el dueño cuando no lo hizo. Lo que decide el
      reparto no es quién apretó el botón sino las constancias, que ya están
      resueltas una línea más arriba.
    */
    const resultado = await this.bookings.cancel(booking.renterId, bookingId, {
      reason:
        `Retiro en disputa, resuelto a favor de ` +
        `${aFavorDe === "OWNER" ? "el dueño" : "quien alquiló"}: ${reason}`,
    });

    return { resolvedFor: aFavorDe, ...resultado };
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

      // ── Todo lo que cuelga de una reserva, en orden ────────────────────
      //
      // Cada una de estas tablas referencia a la reserva o al contrato con
      // Restrict, a propósito: una firma, un asiento contable o un reclamo no
      // se borran solos porque alguien borró lo que describen. Para borrar la
      // CUENTA entera hay que sacarlos explícitamente, y el orden importa:
      // primero lo que apunta, después lo apuntado.
      const contratos = await tx.contract.findMany({
        where: { bookingId: { in: bookingIds } },
        select: { id: true },
      });
      await tx.contractAcceptance.deleteMany({
        where: {
          OR: [
            { contractId: { in: contratos.map((c) => c.id) } },
            { userId: id },
          ],
        },
      });
      await tx.contract.deleteMany({
        where: { bookingId: { in: bookingIds } },
      });

      await tx.damageClaim.deleteMany({
        where: {
          OR: [
            { bookingId: { in: bookingIds } },
            { ownerId: id },
            { renterId: id },
          ],
        },
      });

      // Las partidas antes que el asiento que las agrupa.
      const asientos = await tx.ledgerJournal.findMany({
        where: { bookingId: { in: bookingIds } },
        select: { id: true },
      });
      await tx.ledgerEntry.deleteMany({
        where: {
          OR: [
            { journalId: { in: asientos.map((a) => a.id) } },
            { userId: id },
          ],
        },
      });
      await tx.ledgerJournal.deleteMany({
        where: { bookingId: { in: bookingIds } },
      });

      // El registro de auditoría de cada cobro apunta al cobro con Restrict.
      await tx.paymentEvent.deleteMany({
        where: { OR: [{ bookingId: { in: bookingIds } }, { actorId: id }] },
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
      // La verificación del auto apunta al auto: va antes que el auto.
      await tx.vehicleVerification.deleteMany({ where: { ownerId: id } });
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
