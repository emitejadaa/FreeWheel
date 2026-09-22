import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { BookingStatus, ListingStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateAvailabilityBlockDto } from "./dto/create-availability-block.dto";

export const blockingBookingStatuses: BookingStatus[] = [
  BookingStatus.ACCEPTED,
  BookingStatus.READY_FOR_PICKUP,
  BookingStatus.IN_PROGRESS,
  BookingStatus.RETURN_PENDING,
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Fecha (UTC) como YYYY-MM-DD, sin la parte de hora. */
function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Medianoche UTC del día de una fecha. */
function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * Ventana de días pedida, como intervalo semiabierto sobre días COMPLETOS:
 * `[medianoche(desde), medianoche(hasta) + 1 día)`.
 *
 * Es la pieza que faltaba. Alquilar se piensa por días, no por horas: pedir "del
 * 30 al 30" es pedir el día 30 entero. La consulta que se hacía antes comparaba
 * las fechas tal cual venían, así que con desde = hasta el rango quedaba vacío y
 * NINGUNA reserva daba solapamiento: un auto ocupado el 30 aparecía como libre si
 * se buscaba del 30 al 30.
 */
function dayWindow(startDate: Date, endDate: Date): { from: Date; to: Date } {
  return {
    from: startOfUtcDay(startDate),
    to: new Date(startOfUtcDay(endDate).getTime() + MS_PER_DAY),
  };
}

/**
 * Condición de solapamiento entre una ocupación guardada (reserva o bloqueo) y
 * la ventana de días pedida.
 *
 * El día de devolución cuenta como ocupado: si el auto vuelve el 30, ese día no
 * se puede volver a alquilar. Con eso, la condición sobre la ventana [desde,
 * hasta+1día) es `guardada.startDate < hasta+1día` y `guardada.endDate >= desde`.
 *
 * Vale para las dos consultas —el detalle de disponibilidad y el filtro del
 * listado— justamente para que no puedan volver a contestar cosas distintas: el
 * panel del auto decía "30 jul ocupado" y el filtro lo mostraba como disponible.
 */
export function overlappingRangeWhere(
  startDate: Date,
  endDate: Date,
): { startDate: { lt: Date }; endDate: { gte: Date } } {
  const { from, to } = dayWindow(startDate, endDate);
  return { startDate: { lt: to }, endDate: { gte: from } };
}

/**
 * Convierte rangos de ocupación en la lista de días ocupados que caen dentro de
 * la ventana consultada. El día de devolución (endDate) cuenta como ocupado
 * porque el auto todavía no volvió a estar libre esa jornada.
 */
function expandRangesToDays(
  ranges: { startDate: Date; endDate: Date }[],
  windowStart: Date,
  windowEnd: Date,
): string[] {
  const days = new Set<string>();
  const from = startOfUtcDay(windowStart).getTime();
  const to = startOfUtcDay(windowEnd).getTime();

  for (const range of ranges) {
    let cursor = Math.max(startOfUtcDay(range.startDate).getTime(), from);
    const last = Math.min(startOfUtcDay(range.endDate).getTime(), to);
    // Tope de seguridad: una ventana de consulta no debería superar el año.
    for (let guard = 0; cursor <= last && guard < 750; guard++) {
      days.add(toDayKey(new Date(cursor)));
      cursor += MS_PER_DAY;
    }
  }

  return [...days].sort();
}

@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async getListingAvailability(
    listingId: string,
    startDate: Date,
    endDate: Date,
  ) {
    this.assertDateRange(startDate, endDate, { allowPast: true });
    const listing = await this.findListing(listingId);
    const [bookings, manualBlocks] = await Promise.all([
      this.prisma.booking.findMany({
        where: this.overlappingBookingsWhere(listingId, startDate, endDate),
        select: {
          id: true,
          startDate: true,
          endDate: true,
          status: true,
        },
        orderBy: { startDate: "asc" },
      }),
      this.prisma.listingAvailabilityBlock.findMany({
        where: this.overlappingBlocksWhere(listingId, startDate, endDate),
        select: {
          id: true,
          startDate: true,
          endDate: true,
          reason: true,
        },
        orderBy: { startDate: "asc" },
      }),
    ]);

    return {
      listingId,
      vehicleId: listing.vehicleId,
      startDate,
      endDate,
      available:
        listing.status === ListingStatus.ACTIVE &&
        bookings.length === 0 &&
        manualBlocks.length === 0,
      listingStatus: listing.status,
      blockingBookings: bookings,
      manualBlocks,
      // Mismos rangos, ya expandidos día por día (YYYY-MM-DD): es lo que el
      // calendario del front necesita para pintar/bloquear fechas sin tener que
      // recalcular solapamientos en el navegador.
      unavailableDates: expandRangesToDays(
        [...bookings, ...manualBlocks],
        startDate,
        endDate,
      ),
    };
  }

  async createBlock(
    ownerId: string,
    listingId: string,
    data: CreateAvailabilityBlockDto,
  ) {
    this.assertDateRange(data.startDate, data.endDate);
    const listing = await this.findListing(listingId);
    this.assertListingOwner(listing.ownerId, ownerId);

    await this.assertNoManualBlockOverlap(
      listingId,
      data.startDate,
      data.endDate,
    );

    return this.prisma.listingAvailabilityBlock.create({
      data: {
        listingId,
        ownerId,
        startDate: data.startDate,
        endDate: data.endDate,
        reason: data.reason,
      },
      include: { listing: true },
    });
  }

  async listBlocks(ownerId: string, listingId: string) {
    const listing = await this.findListing(listingId);
    this.assertListingOwner(listing.ownerId, ownerId);

    return this.prisma.listingAvailabilityBlock.findMany({
      where: { listingId },
      orderBy: { startDate: "asc" },
    });
  }

  async deleteBlock(ownerId: string, listingId: string, blockId: string) {
    const listing = await this.findListing(listingId);
    this.assertListingOwner(listing.ownerId, ownerId);

    const block = await this.prisma.listingAvailabilityBlock.findUnique({
      where: { id: blockId },
    });

    if (!block || block.listingId !== listingId) {
      throw new NotFoundException("Availability block not found");
    }

    await this.prisma.listingAvailabilityBlock.delete({
      where: { id: blockId },
    });

    return { deleted: true, id: blockId };
  }

  async assertListingIsBookable(
    listingId: string,
    startDate: Date,
    endDate: Date,
    excludeBookingId?: string,
  ) {
    await this.assertNoBookingOverlap(
      listingId,
      startDate,
      endDate,
      excludeBookingId,
    );
    await this.assertNoManualBlockOverlap(listingId, startDate, endDate);
  }

  assertDateRange(
    startDate: Date,
    endDate: Date,
    options: { allowPast?: boolean } = {},
  ) {
    if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
      throw new BadRequestException("Invalid startDate");
    }

    if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestException("Invalid endDate");
    }

    // El día de hoy nunca cuenta para alquilar, sin importar la hora: no hay
    // reservas del mismo día, el primer día posible es siempre mañana. Antes se
    // comparaba contra el instante actual (`startDate <= new Date()`), así que
    // a las 16:40 alguien podía reservar para las 20:00 de ese mismo día.
    if (!options.allowPast) {
      const today = startOfUtcDay(new Date());
      if (startOfUtcDay(startDate).getTime() <= today.getTime()) {
        throw new BadRequestException(
          "startDate must be at least tomorrow (same-day bookings are not allowed)",
        );
      }
    }

    if (endDate <= startDate) {
      throw new BadRequestException("endDate must be after startDate");
    }
  }

  /**
   * CUÁNTOS DÍAS SE COBRAN, con quince minutos de gracia.
   *
   * Un alquiler se cobra por día empezado: pasarse unas horas del día número
   * tres cuesta el cuarto día, y así funciona en cualquier rentadora.
   *
   * Lo que NO puede pasar es que pasarse por un milisegundo cueste lo mismo.
   * Antes esto era un `ceil` pelado sobre la diferencia en milisegundos, así
   * que una reserva "del 5 al 8" armada con la hora exacta de cada momento
   * —que es lo que manda un formulario cuando las dos fechas no se generan en
   * el mismo instante— daba 3 días y una pizca, y se cobraban 4. Un día
   * entero de más por un redondeo es justamente el cobro que después hay que
   * explicarle a alguien que reclama, y tiene razón.
   *
   * Con quince minutos de gracia, la misma hora de un día posterior cuenta
   * los días que cualquiera diría que son, y pasarse de verdad sigue
   * costando el día siguiente.
   */
  calculateDays(startDate: Date, endDate: Date) {
    const DIA = 1000 * 60 * 60 * 24;
    const GRACIA = 15 * 60 * 1000;
    const milliseconds = endDate.getTime() - startDate.getTime();

    // Cero o negativo se devuelve tal cual: quien llama lo rechaza, y
    // restarle la gracia acá convertiría un error en "cero días".
    if (milliseconds <= 0) return Math.ceil(milliseconds / DIA);

    return Math.max(1, Math.ceil((milliseconds - GRACIA) / DIA));
  }

  async assertNoManualBlockOverlap(
    listingId: string,
    startDate: Date,
    endDate: Date,
    excludeBlockId?: string,
  ) {
    const overlapping = await this.prisma.listingAvailabilityBlock.findFirst({
      where: {
        ...this.overlappingBlocksWhere(listingId, startDate, endDate),
        ...(excludeBlockId ? { id: { not: excludeBlockId } } : {}),
      },
    });

    if (overlapping) {
      throw new BadRequestException(
        "Dates overlap with a manual availability block",
      );
    }
  }

  private async assertNoBookingOverlap(
    listingId: string,
    startDate: Date,
    endDate: Date,
    excludeBookingId?: string,
  ) {
    const overlapping = await this.prisma.booking.findFirst({
      where: {
        ...this.overlappingBookingsWhere(listingId, startDate, endDate),
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      },
    });

    if (overlapping) {
      throw new BadRequestException(
        "Booking dates overlap with another active booking",
      );
    }
  }

  private overlappingBookingsWhere(
    listingId: string,
    startDate: Date,
    endDate: Date,
  ) {
    return {
      listingId,
      status: { in: blockingBookingStatuses },
      ...overlappingRangeWhere(startDate, endDate),
    };
  }

  private overlappingBlocksWhere(
    listingId: string,
    startDate: Date,
    endDate: Date,
  ) {
    return {
      listingId,
      ...overlappingRangeWhere(startDate, endDate),
    };
  }

  private async findListing(listingId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: { vehicle: true },
    });

    if (!listing) {
      throw new NotFoundException("Listing not found");
    }

    return listing;
  }

  private assertListingOwner(listingOwnerId: string, userId: string) {
    if (listingOwnerId !== userId) {
      throw new ForbiddenException("You cannot manage this listing");
    }
  }
}
