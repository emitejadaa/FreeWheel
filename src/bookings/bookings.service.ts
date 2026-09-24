import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Booking,
  BookingStatus,
  ListingStatus,
  MediaAssetKind,
  MediaAssetStatus,
  PaymentStatus,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { AvailabilityService } from "../availability/availability.service";
import { AuditLogService } from "../common/services/audit-log.service";
import { EncryptionService } from "../common/crypto/encryption.service";
import { ContractsService } from "../contracts/contracts.service";
import type { AcceptanceContext } from "../contracts/contracts.service";
import { VehicleVerificationService } from "../vehicle-verification/vehicle-verification.service";
import { EmailService } from "../email/email.service";
import { PaymentsService } from "../payments/payments.service";
import { PricingService } from "../payments/pricing.service";
import { PrismaService } from "../prisma/prisma.service";
import { assertFound } from "../common/utils/entity.util";
import {
  assertOwner,
  assertParticipant,
} from "../common/utils/authorization.util";
import { generateOpaqueToken } from "../common/utils/verification-code.util";
import { BOOKING_PARTICIPANT_INCLUDE } from "../common/constants/prisma-select";
import { decidirCancelacion } from "./cancellation-policy";
import { CancelBookingDto } from "./dto/cancel-booking.dto";
import { CreateBookingDto } from "./dto/create-booking.dto";

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly availability: AvailabilityService,
    private readonly payments: PaymentsService,
    private readonly pricing: PricingService,
    private readonly contracts: ContractsService,
    private readonly email: EmailService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
    private readonly vehicleVerification: VehicleVerificationService,
  ) {}

  async create(renterId: string, data: CreateBookingDto) {
    this.availability.assertDateRange(data.startDate, data.endDate);

    const listing = await this.prisma.listing.findUnique({
      where: { id: data.listingId },
      include: { vehicle: true },
    });

    if (!listing || listing.status !== ListingStatus.ACTIVE) {
      throw new BadRequestException("Listing is not available for booking");
    }

    if (listing.ownerId === renterId) {
      throw new ForbiddenException("You cannot book your own listing");
    }

    // Que el auto sea de quien lo publica y tenga el seguro vigente (con
    // REQUIRE_VEHICLE_VERIFICATION=true; ver VehicleVerificationService).
    await this.vehicleVerification.assertVehicleVerified(listing.vehicleId);

    await this.availability.assertListingIsBookable(
      listing.id,
      data.startDate,
      data.endDate,
    );

    const days = this.availability.calculateDays(data.startDate, data.endDate);
    const totalPriceSnapshot = listing.pricePerDay * days;

    const created = await this.prisma.booking.create({
      data: {
        listingId: listing.id,
        vehicleId: listing.vehicleId,
        ownerId: listing.ownerId,
        renterId,
        startDate: data.startDate,
        endDate: data.endDate,
        pricePerDaySnapshot: listing.pricePerDay,
        totalPriceSnapshot,
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    await this.auditLog.create({
      actorId: renterId,
      targetUserId: listing.ownerId,
      action: "booking.created",
      entityType: "Booking",
      entityId: created.id,
      metadata: { status: BookingStatus.REQUESTED },
    });

    this.logger.log(
      `Booking ${created.id} requested by renter ${renterId} on listing ${listing.id}`,
    );

    // Las DOS partes se enteran. Antes solo se avisaba al dueño: quien reservaba
    // mandaba el pedido y no recibía nada, así que no tenía por escrito ni qué
    // auto pidió ni cuánto iba a pagar.
    await this.safeNotify(() => {
      if (!created.owner?.email) return;
      return this.email.sendBookingRequestedToOwner(created.owner.email, {
        ownerName: this.personName(created.owner),
        renterName: this.personName(created.renter),
        vehicleLabel: this.vehicleLabel(created),
        startDate: created.startDate,
        endDate: created.endDate,
        totalPrice: created.totalPriceSnapshot,
        currency: created.currency,
      });
    });

    await this.safeNotify(() => {
      if (!created.renter?.email) return;
      return this.email.sendBookingRequestedToRenter(created.renter.email, {
        renterName: this.personName(created.renter),
        ownerName: this.personName(created.owner),
        vehicleLabel: this.vehicleLabel(created),
        startDate: created.startDate,
        endDate: created.endDate,
        totalPrice: created.totalPriceSnapshot,
        currency: created.currency,
      });
    });

    return publicBooking(created);
  }

  async findMine(userId: string) {
    const bookings = await this.prisma.booking.findMany({
      where: {
        OR: [{ renterId: userId }, { ownerId: userId }],
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
      orderBy: { createdAt: "desc" },
    });

    return (await this.withVehiclePhotos(bookings)).map(publicBooking);
  }

  async findOneForParticipant(userId: string, id: string) {
    const booking = await this.findById(id);
    this.assertBookingParticipant(booking, userId);

    const [withPhotos] = await this.withVehiclePhotos([booking]);
    return publicBooking(withPhotos);
  }

  /**
   * Agrega a cada reserva las fotos del vehículo (`listing.photos`), que viven
   * en MediaAsset y no en la relación. Sin esto las tarjetas de "Mis reservas"
   * se ven siempre como "Sin foto".
   */
  private async withVehiclePhotos<T extends { vehicleId: string }>(
    bookings: T[],
  ): Promise<(T & { photos: string[] })[]> {
    if (bookings.length === 0) return [];

    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        entityType: "vehicle",
        entityId: { in: bookings.map((booking) => booking.vehicleId) },
        kind: MediaAssetKind.VEHICLE_PHOTO,
        status: MediaAssetStatus.ACTIVE,
      },
      select: { entityId: true, url: true },
      orderBy: { createdAt: "asc" },
    });

    const byVehicle = new Map<string, string[]>();
    for (const asset of assets) {
      if (!asset.entityId) continue;
      const urls = byVehicle.get(asset.entityId) ?? [];
      urls.push(asset.url);
      byVehicle.set(asset.entityId, urls);
    }

    return bookings.map((booking) => {
      const photos = byVehicle.get(booking.vehicleId) ?? [];
      const listing = (booking as { listing?: object }).listing;
      return {
        ...booking,
        photos,
        ...(listing ? { listing: { ...listing, photos } } : {}),
      };
    });
  }

  async accept(ownerId: string, id: string, ctx: AcceptanceContext = {}) {
    const booking = await this.findById(id);
    this.assertBookingOwner(booking, ownerId);

    if (booking.status !== BookingStatus.REQUESTED) {
      throw new BadRequestException("Only requested bookings can be accepted");
    }

    // Aceptar es comprometerse a cobrar por esta reserva, y con Mercado Pago
    // el cobro se hace EN LA CUENTA DEL DUEÑO. Sin la cuenta vinculada, quien
    // alquila no tendría cómo pagar: se frena acá, que es donde el dueño lo
    // puede arreglar en el momento, y no en la pantalla de pago de la otra
    // persona.
    await this.payments.assertOwnerCanCollect(ownerId);

    await this.availability.assertListingIsBookable(
      booking.listingId,
      booking.startDate,
      booking.endDate,
      id,
    );

    const days = this.availability.calculateDays(
      booking.startDate,
      booking.endDate,
    );
    const pricing = this.pricing.computeBooking({
      pricePerDay: booking.pricePerDaySnapshot,
      days,
    });

    const pickupToken = generateOpaqueToken(24);
    const returnToken = generateOpaqueToken(24);
    const updated = await this.prisma.booking.update({
      where: { id },
      data: {
        status: BookingStatus.ACCEPTED,
        paymentStatus: PaymentStatus.PENDING,
        pickupTokenHash: await bcrypt.hash(pickupToken, 10),
        returnTokenHash: await bcrypt.hash(returnToken, 10),
        // Los códigos se guardan CIFRADOS. Hace falta poder volver a
        // mostrarlos (el QR se pierde si la persona cierra la app), así que no
        // alcanza con el hash; pero en claro, cualquiera con acceso a la base
        // podía confirmar una entrega o una devolución que no pasó.
        pickupTokenPreview: this.encryption.encrypt(pickupToken),
        returnTokenPreview: this.encryption.encrypt(returnToken),
        currency: pricing.currency,
        totalPriceSnapshot: pricing.total,
        rentalSubtotalSnapshot: pricing.rentalSubtotal,
        insuranceSnapshot: pricing.insurance,
        platformFeeSnapshot: pricing.commission,
        senaAmountSnapshot: pricing.sena,
        // Ya no hay saldo aparte: el pago es uno solo. Queda en null para las
        // reservas nuevas (el ticket muestra el detalle).
        balanceAmountSnapshot: null,
        depositSnapshot: pricing.deposit,
        ownerPayoutSnapshot: pricing.ownerPayout,
        transferGroup: `booking_${id}`,
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    // El contrato se genera con los precios recién congelados, y ACEPTAR LA
    // RESERVA ES ACEPTAR EL CONTRATO para el dueño: queda registrado con su
    // IP y su navegador, igual que la aceptación de quien alquila.
    await this.contracts.ensureForBooking(id);
    await this.contracts.accept(ownerId, id, ctx);

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: "booking.accepted",
      entityType: "Booking",
      entityId: id,
      metadata: { status: BookingStatus.ACCEPTED },
    });

    this.logger.log(`Booking ${id} accepted by owner ${ownerId}`);

    await this.safeNotify(() => {
      if (!updated.renter?.email) return;
      return this.email.sendBookingAcceptedToRenter(updated.renter.email, {
        renterName: this.personName(updated.renter),
        vehicleLabel: this.vehicleLabel(updated),
        startDate: updated.startDate,
        endDate: updated.endDate,
      });
    });

    // Al dueño se le devuelve SOLO el código de devolución, que es el que él
    // tiene que mostrar al final. El de entrega es de quien alquila: si el
    // dueño lo tuviera, podría confirmar solo una entrega que no hizo.
    return {
      ...publicBooking(updated),
      returnQrToken: returnToken,
    };
  }

  async reject(ownerId: string, id: string) {
    const booking = await this.findById(id);
    this.assertBookingOwner(booking, ownerId);

    if (booking.status !== BookingStatus.REQUESTED) {
      throw new BadRequestException("Only requested bookings can be rejected");
    }

    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.REJECTED },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: "booking.rejected",
      entityType: "Booking",
      entityId: id,
      metadata: { status: BookingStatus.REJECTED },
    });

    this.logger.log(`Booking ${id} rejected by owner ${ownerId}`);

    await this.safeNotify(() => {
      if (!updated.renter?.email) return;
      return this.email.sendBookingRejectedToRenter(updated.renter.email, {
        renterName: this.personName(updated.renter),
        vehicleLabel: this.vehicleLabel(updated),
        startDate: updated.startDate,
        endDate: updated.endDate,
      });
    });

    return publicBooking(updated);
  }

  async cancel(userId: string, id: string, data: CancelBookingDto) {
    const booking = await this.findById(id);
    this.assertBookingParticipant(booking, userId);

    const laCancelaElDueno = userId !== booking.renterId;

    /*
      LA POLÍTICA DE CANCELACIÓN, en un solo lugar y con sus pruebas.

      Hasta acá se devolvía el CIEN POR CIENTO en cualquier momento, hasta el
      minuto anterior al retiro. Suena generoso y es un agujero: alguien podía
      tener un auto bloqueado un mes, soltarlo el día anterior sin costo, y el
      dueño se quedaba sin el alquiler Y sin las fechas. Ver
      cancellation-policy.ts, que explica los plazos y por qué son esos.
    */
    const decision = decidirCancelacion({
      status: booking.status,
      startDate: booking.startDate,
      ahora: new Date(),
      laCancelaElDueno,
    });
    if (!decision.puede) {
      throw new BadRequestException({
        statusCode: 400,
        code: decision.motivo,
        message:
          decision.motivo === "BOOKING_IN_PROGRESS"
            ? "El auto ya está entregado: esta reserva no se cancela, se " +
              "devuelve el auto. Devolverlo antes libera las fechas que sobran."
            : "Esta reserva ya no se puede cancelar.",
      });
    }

    const esInquilino = !laCancelaElDueno;
    const status = laCancelaElDueno
      ? BookingStatus.CANCELLED_BY_OWNER
      : BookingStatus.CANCELLED_BY_RENTER;

    /*
      LA PLATA PRIMERO, PERO SIN QUE UNA FALLA TIRE ABAJO LA CANCELACIÓN.

      El orden importa: repartir antes de cambiar el estado hace que un reparto
      a medias no deje una reserva "cancelada" con la plata sin devolver, y
      cada paso del reparto es idempotente, así que reintentar lo termina.

      Pero una excepción acá tampoco puede contestar 500 sobre una cancelación
      que la persona pidió y que sí corresponde: falla casi siempre por lo
      mismo —el dueño sin el alta de cobros terminada, cuando hay que
      transferirle la seña retenida— y eso no es motivo para dejarle la reserva
      activa. Así que se cancela igual y la falla viaja en la respuesta, para
      que la pantalla la pueda contar.
    */
    const refundable: PaymentStatus[] = [
      PaymentStatus.DEPOSIT_PAID,
      PaymentStatus.FULLY_PAID,
      PaymentStatus.PARTIALLY_REFUNDED,
    ];
    let settlement: Awaited<
      ReturnType<PaymentsService["cancelAndSettle"]>
    > | null = null;
    let refund: { ok: boolean; code: string | null; message: string | null } = {
      ok: true,
      code: null,
      message: null,
    };
    if (refundable.includes(booking.paymentStatus)) {
      try {
        settlement = await this.payments.cancelAndSettle(
          id,
          esInquilino ? "RENTER" : "OWNER",
          userId,
          // "delDueno" y "cerrada" no llegan acá: el primero devuelve todo
          // igual por ser el dueño quien cancela, y el segundo ya rebotó
          // arriba. Se mapean a "libre" para no inventar un tramo.
          { tier: decision.tier === "tardia" ? "tardia" : "libre" },
        );
      } catch (error) {
        refund = {
          ok: false,
          code: this.codigoDelError(error) ?? "REFUND_FAILED",
          message:
            "La reserva quedó cancelada, pero la devolución del dinero no se " +
            "pudo completar. Lo reintentamos.",
        };
        this.logger.error(
          `no se pudo repartir la plata de la cancelación ${id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const updated = await this.prisma.booking.update({
      where: { id },
      data: {
        status,
        cancelledAt: new Date(),
        cancellationReason: data.reason,
        cancelledByRole: esInquilino ? "RENTER" : "OWNER",
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    await this.auditLog.create({
      actorId: userId,
      targetUserId:
        userId === booking.renterId ? booking.ownerId : booking.renterId,
      action: "booking.cancelled",
      entityType: "Booking",
      entityId: id,
      metadata: { status, rule: settlement?.rule ?? "UNPAID" },
    });

    this.logger.log(`Booking ${id} cancelled by ${userId} (${status})`);

    // A las dos partes: a quien canceló como constancia, y a la otra porque le
    // cambia el plan. Antes una cancelación no generaba ningún mail, así que la
    // otra persona se enteraba solo si entraba a la app.
    const canceloElInquilino = status === BookingStatus.CANCELLED_BY_RENTER;
    const seDevuelvePlata = (settlement?.refundToRenterMinor ?? 0) > 0;

    /*
      EL MAIL DICE QUÉ POLÍTICA SE APLICÓ Y CUÁNTO VUELVE.

      Una política clara que no se cuenta en el momento en que se aplica no es
      clara: quien cancela la noche anterior tiene que leer POR QUÉ no le
      vuelve la seña, ahí, en el mismo mail que le confirma la cancelación, y
      no descubrirlo tres días después mirando el resumen de la tarjeta.
    */
    const senaRetenida =
      decision.retieneSena && seDevuelvePlata
        ? (booking.senaAmountSnapshot ?? null)
        : null;

    for (const parte of [
      {
        datos: updated.renter,
        otra: updated.owner,
        cancelaste: canceloElInquilino,
      },
      {
        datos: updated.owner,
        otra: updated.renter,
        cancelaste: !canceloElInquilino,
      },
    ]) {
      await this.safeNotify(() => {
        if (!parte.datos?.email) return;
        return this.email.sendBookingCancelled(parte.datos.email, {
          recipientName: this.personName(parte.datos),
          otherPartyName: this.personName(parte.otra),
          vehicleLabel: this.vehicleLabel(updated),
          startDate: updated.startDate,
          endDate: updated.endDate,
          reason: updated.cancellationReason,
          cancelaste: parte.cancelaste,
          refunded: seDevuelvePlata,
          tier: decision.tier,
          senaRetenida: senaRetenida != null ? Number(senaRetenida) : null,
          currency: updated.currency,
        });
      });
    }

    return {
      ...publicBooking(updated),
      // El tramo y "¿se retiene la seña?" los lee la pantalla de cancelación;
      // el reparto detallado es el respaldo de qué se devolvió y por qué.
      cancellation: {
        tier: decision.tier,
        retieneSena: decision.retieneSena,
        ...(settlement ?? {}),
      },
      refund,
    };
  }

  /** Lo que pasaría si esta persona cancelara ahora. No cancela nada. */
  async cancellationPreview(userId: string, id: string) {
    const booking = await this.findById(id);
    this.assertBookingParticipant(booking, userId);
    return this.payments.previewCancellation(userId, id);
  }

  async readyForPickup(ownerId: string, id: string) {
    const booking = await this.findById(id);
    this.assertBookingOwner(booking, ownerId);

    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(
        "Only accepted bookings can be marked ready",
      );
    }

    if (booking.paymentStatus !== PaymentStatus.FULLY_PAID) {
      throw new ConflictException({
        statusCode: 409,
        code: "CHECKOUT_NOT_PAID",
        message: "La reserva todavía no está paga.",
      });
    }

    // El depósito se autoriza ACÁ, cerca del retiro, y no al pagar: una
    // retención en tarjeta vence sola en unos días, y autorizarla semanas
    // antes era autorizar algo que se iba a soltar antes de que nadie
    // retirara el auto.
    const deposito = await this.payments.authorizeDepositForPickup(id, ownerId);
    if (!deposito.authorized) {
      throw new ConflictException({
        statusCode: 409,
        code: "DEPOSIT_AUTHORIZATION_REQUIRED",
        message:
          "El banco de quien alquila pidió que autorice el depósito en " +
          "garantía personalmente. Ya puede hacerlo desde la reserva; cuando " +
          "lo haga, marcá el auto listo otra vez.",
      });
    }
    await this.payments.assertReadyForPickup(id);

    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.READY_FOR_PICKUP },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: "booking.ready_for_pickup",
      entityType: "Booking",
      entityId: id,
      metadata: { status: BookingStatus.READY_FOR_PICKUP },
    });

    this.logger.log(
      `Booking ${id} marked ready for pickup by owner ${ownerId}`,
    );

    // ¿La retención llega viva al final de la ventana de inspección? Si no,
    // un daño reclamado tarde ya no se puede cobrar del depósito, y el dueño
    // tiene que saberlo antes de entregar el auto.
    const finDeInspeccion = new Date(
      updated.endDate.getTime() + this.inspectionHours() * 60 * 60 * 1000,
    );
    return {
      ...publicBooking(updated),
      depositCoversInspection:
        !updated.depositHoldExpiresAt ||
        updated.depositHoldExpiresAt >= finDeInspeccion,
    };
  }

  async getTokens(userId: string, id: string) {
    const booking = await this.findById(id);
    this.assertBookingParticipant(booking, userId);

    return {
      // The renter sees the pickup QR only while the booking is ready for
      // pickup; the owner sees the return QR only once the rental is underway.
      pickupQrToken:
        userId === booking.renterId &&
        ([BookingStatus.READY_FOR_PICKUP] as BookingStatus[]).includes(
          booking.status,
        )
          ? (this.encryption.tryDecrypt(booking.pickupTokenPreview) ??
            undefined)
          : undefined,
      returnQrToken:
        userId === booking.ownerId &&
        (
          [
            BookingStatus.IN_PROGRESS,
            BookingStatus.RETURN_PENDING,
          ] as BookingStatus[]
        ).includes(booking.status)
          ? (this.encryption.tryDecrypt(booking.returnTokenPreview) ??
            undefined)
          : undefined,
    };
  }

  async confirmPickup(ownerId: string, id: string, token: string) {
    const booking = await this.findById(id);
    this.assertBookingOwner(booking, ownerId);

    if (
      !([BookingStatus.READY_FOR_PICKUP] as BookingStatus[]).includes(
        booking.status,
      )
    ) {
      throw new BadRequestException(
        "Pickup cannot be confirmed in this status",
      );
    }

    if (!booking.pickupTokenHash) {
      throw new BadRequestException("Pickup token was not generated");
    }

    if (!(await bcrypt.compare(token, booking.pickupTokenHash))) {
      throw new ForbiddenException("Invalid pickup token");
    }

    const updated = await this.prisma.booking.update({
      where: { id },
      data: {
        status: BookingStatus.IN_PROGRESS,
        pickupConfirmedAt: new Date(),
        pickupTokenHash: null,
        pickupTokenPreview: null,
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    await this.auditLog.create({
      actorId: ownerId,
      targetUserId: booking.renterId,
      action: "booking.pickup_confirmed",
      entityType: "Booking",
      entityId: id,
      metadata: { status: BookingStatus.IN_PROGRESS },
    });

    this.logger.log(`Booking ${id} pickup confirmed by owner ${ownerId}`);

    // La entrega es el momento en que empieza a correr el alquiler: las dos
    // partes necesitan la constancia, y con la misma hora.
    const entregadoEl = updated.pickupConfirmedAt ?? new Date();
    for (const persona of [
      { datos: updated.owner, esDueño: true },
      { datos: updated.renter, esDueño: false },
    ]) {
      await this.safeNotify(() => {
        if (!persona.datos?.email) return;
        return this.email.sendPickupConfirmed(persona.datos.email, {
          recipientName: this.personName(persona.datos),
          vehicleLabel: this.vehicleLabel(updated),
          startDate: updated.startDate,
          endDate: updated.endDate,
          confirmedAt: entregadoEl,
          esDueño: persona.esDueño,
        });
      });
    }

    return publicBooking(updated);
  }

  async confirmReturn(renterId: string, id: string, token: string) {
    const booking = await this.findById(id);

    if (booking.renterId !== renterId) {
      throw new ForbiddenException("Only the renter can confirm return");
    }

    if (
      !(
        [
          BookingStatus.IN_PROGRESS,
          BookingStatus.RETURN_PENDING,
        ] as BookingStatus[]
      ).includes(booking.status)
    ) {
      throw new BadRequestException(
        "Return cannot be confirmed in this status",
      );
    }

    if (!booking.returnTokenHash) {
      throw new BadRequestException("Return token was not generated");
    }

    if (!(await bcrypt.compare(token, booking.returnTokenHash))) {
      throw new ForbiddenException("Invalid return token");
    }

    // DEVUELTO NO ES CERRADO. Se abre la ventana de inspección: el dueño
    // tiene DAMAGE_REPORT_WINDOW_HOURS (48 por omisión) para reportar un daño
    // con fotos. Recién cuando se cierra sin reclamo —o el reclamo se
    // resuelve— se libera el depósito y se le paga. Antes la devolución
    // liquidaba todo en el acto, y el dueño que encontraba un golpe al revisar
    // el auto una hora después ya no tenía de dónde cobrarlo.
    const ahora = new Date();
    const updated = await this.prisma.booking.update({
      where: { id },
      data: {
        status: BookingStatus.INSPECTION,
        returnConfirmedAt: ahora,
        inspectionEndsAt: new Date(
          ahora.getTime() + this.inspectionHours() * 60 * 60 * 1000,
        ),
        returnTokenHash: null,
        returnTokenPreview: null,
      },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });

    await this.auditLog.create({
      actorId: renterId,
      targetUserId: booking.ownerId,
      action: "booking.return_confirmed",
      entityType: "Booking",
      entityId: id,
      metadata: {
        status: BookingStatus.INSPECTION,
        inspectionEndsAt: updated.inspectionEndsAt,
      },
    });

    this.logger.log(`Booking ${id} return confirmed by renter ${renterId}`);

    // La reserva quedó cerrada: las dos partes reciben la constancia y la
    // invitación a reseñar, que es cuando de verdad tiene sentido pedirla.
    const devueltoEl = updated.returnConfirmedAt ?? new Date();
    for (const persona of [
      { datos: updated.owner, otra: updated.renter, esDueño: true },
      { datos: updated.renter, otra: updated.owner, esDueño: false },
    ]) {
      await this.safeNotify(() => {
        if (!persona.datos?.email) return;
        return this.email.sendReturnConfirmed(persona.datos.email, {
          recipientName: this.personName(persona.datos),
          otherPartyName: this.personName(persona.otra),
          vehicleLabel: this.vehicleLabel(updated),
          confirmedAt: devueltoEl,
          esDueño: persona.esDueño,
          // El dueño tiene una ventana para revisar el auto y reclamar un
          // daño; mientras tanto el depósito sigue retenido. Este mail es el
          // único momento en que se le puede decir.
          horasDeRevision: this.inspectionHours(),
        });
      });
    }

    return publicBooking(updated);
  }

  /**
   * Liquida la reserva si la ventana de inspección ya se cerró. Lo corre el
   * cron todos los días; esto deja que cualquiera de las dos partes no tenga
   * que esperarlo.
   */
  async settle(userId: string, id: string) {
    const booking = await this.findById(id);
    this.assertBookingParticipant(booking, userId);
    const result = await this.payments.settleBooking(id, userId);
    if (!result.settled) {
      throw new ConflictException({
        statusCode: 409,
        code: result.reason ?? "NOT_SETTLEABLE",
        message:
          result.reason === "INSPECTION_WINDOW_OPEN"
            ? "La ventana para reportar daños todavía está abierta."
            : result.reason === "CLAIM_OPEN"
              ? "Hay un reclamo por daños sin resolver."
              : result.reason === "PAYMENT_DISPUTED"
                ? "El pago fue desconocido ante el banco: hasta que se " +
                  "resuelva, no se liquida nada."
                : "Esta reserva no se puede liquidar todavía.",
      });
    }
    return this.findOneForParticipant(userId, id);
  }

  private inspectionHours(): number {
    const horas = Number.parseFloat(
      this.config.get<string>("DAMAGE_REPORT_WINDOW_HOURS") ?? "",
    );
    return Number.isFinite(horas) && horas > 0 ? horas : 48;
  }

  /**
   * El código corto de un error, si lo trae.
   *
   * Las excepciones de este backend llevan uno adentro del cuerpo
   * (PAYMENT_DISPUTED, PAYMENTS_NOT_CONFIGURED); las del procesador lo llevan en
   * `code`. Sirve para que el front pueda distinguir "hay una disputa abierta"
   * de "falló la transferencia" sin leer un mensaje en castellano.
   */
  private codigoDelError(error: unknown): string | null {
    if (typeof error !== "object" || error === null) return null;
    const conCode = error as { code?: unknown; getResponse?: () => unknown };
    if (typeof conCode.code === "string") return conCode.code;
    if (typeof conCode.getResponse === "function") {
      const cuerpo = conCode.getResponse();
      if (
        typeof cuerpo === "object" &&
        cuerpo !== null &&
        typeof (cuerpo as { code?: unknown }).code === "string"
      ) {
        return (cuerpo as { code: string }).code;
      }
    }
    return null;
  }

  private async findById(id: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: BOOKING_PARTICIPANT_INCLUDE,
    });
    assertFound(booking, "Booking not found");

    return booking;
  }

  private assertBookingParticipant(booking: Booking, userId: string) {
    assertParticipant(
      booking.ownerId,
      booking.renterId,
      userId,
      "You cannot access this booking",
    );
  }

  private assertBookingOwner(booking: Booking, userId: string) {
    assertOwner(
      booking.ownerId,
      userId,
      "Only the owner can perform this action",
    );
  }

  private async safeNotify(fn: () => Promise<unknown> | void): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error enviando notificacion de reserva: ${message}`);
    }
  }

  private personName(person?: {
    displayName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
  }): string {
    if (!person) return "";
    return (
      person.displayName ||
      [person.firstName, person.lastName].filter(Boolean).join(" ") ||
      person.email ||
      ""
    );
  }

  private vehicleLabel(booking: {
    vehicle?: {
      brand?: string | null;
      model?: string | null;
      year?: number | null;
    } | null;
  }): string {
    const v = booking.vehicle;
    if (!v) return "el vehiculo";
    return (
      [v.brand, v.model, v.year].filter(Boolean).join(" ") || "el vehiculo"
    );
  }
}

/**
 * UNA RESERVA, COMO LA VE QUIEN PARTICIPA DE ELLA.
 *
 * La fila completa NO se devuelve nunca, y no es prolijidad: traía los hashes
 * y los códigos de entrega y devolución. Con el código de devolución a la
 * vista, quien alquila podía confirmar sola que devolvió el auto —lo que
 * libera el depósito y le paga al dueño— sin haberlo devuelto. Los códigos
 * salen únicamente por GET /bookings/:id/tokens, a quien le corresponde cada
 * uno y en el momento en que corresponde.
 *
 * Tampoco salen los identificadores internos del procesador (intents, medio
 * de pago guardado, grupo de transferencia): no le sirven a nadie afuera y
 * son justamente lo que alguien necesitaría para operar sobre el cobro.
 */
export function publicBooking<T extends object>(
  booking: T,
): Omit<
  T,
  | "pickupTokenHash"
  | "returnTokenHash"
  | "pickupTokenPreview"
  | "returnTokenPreview"
  | "savedPaymentMethodId"
  | "checkoutPaymentId"
  | "depositPaymentId"
  | "checkoutPaymentIntentId"
  | "depositPaymentIntentId"
  | "transferGroup"
  | "providerPaymentId"
> {
  // Los nombres viejos (…PaymentIntentId) siguen en la lista por si algo
  // arma una reserva a mano con ellos: sacar de más no rompe nada.
  const {
    pickupTokenHash: _a,
    returnTokenHash: _b,
    pickupTokenPreview: _c,
    returnTokenPreview: _d,
    savedPaymentMethodId: _e,
    checkoutPaymentId: _f,
    depositPaymentId: _g,
    checkoutPaymentIntentId: _f2,
    depositPaymentIntentId: _g2,
    transferGroup: _h,
    providerPaymentId: _i,
    ...visible
  } = booking as Record<string, unknown>;
  void [_a, _b, _c, _d, _e, _f, _g, _f2, _g2, _h, _i];
  return visible as never;
}
