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

/**
 * LAS RESERVAS EN LAS QUE EL AUTO ESTÁ AFUERA Y TODAVÍA NO VOLVIÓ.
 *
 * COMPLETED no está, y eso es lo que hace que devolver antes libere las fechas:
 * quien alquila un mes y devuelve a las dos semanas confirma la devolución, la
 * reserva pasa a COMPLETED, deja de ocupar, y el dueño puede volver a alquilar
 * las dos semanas que sobran. Las fechas guardadas en la reserva no cambian
 * —son las que se pagaron— pero ya no ocupan nada.
 */
export const sinDevolverStatuses: BookingStatus[] = [
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
 * LA CONDICIÓN DE OCUPACIÓN DE UNA RESERVA, que ya no es la misma que la de un
 * bloqueo manual.
 *
 * Un bloqueo del dueño ocupa exactamente los días que dice. Una reserva ocupa
 * hasta que el auto vuelve, que puede ser después: si la reserva terminaba
 * ayer y nadie confirmó la devolución, el auto sigue afuera y hoy no está
 * disponible. Prometerlo igual es prometer un auto que no se tiene, y quien se
 * lleva el golpe es el dueño, que queda con dos personas esperando el mismo
 * auto.
 *
 * Son dos ramas:
 *
 *  1. La de siempre: cualquier reserva que ocupa, con su rango de fechas.
 *  2. Las que no volvieron. Solo se agrega cuando la ventana consultada llega
 *     hasta hoy o más acá, porque el fin efectivo de esas reservas es hoy (ver
 *     effectiveEnd): si se pregunta por un rango que terminó antes de hoy, esa
 *     rama no puede aportar nada y se deja afuera.
 *
 * `hoy` entra por parámetro para poder probar esto sin depender del reloj de la
 * máquina, que es lo que hace que una prueba pase hoy y falle en enero.
 */
export function occupiedBookingWhere(
  startDate: Date,
  endDate: Date,
  hoy: Date = new Date(),
) {
  const { from, to } = dayWindow(startDate, endDate);
  const enCurso = startOfUtcDay(hoy).getTime() >= from.getTime();
  return {
    OR: [
      {
        status: { in: blockingBookingStatuses },
        startDate: { lt: to },
        endDate: { gte: from },
      },
      ...(enCurso
        ? [{ status: { in: sinDevolverStatuses }, startDate: { lt: to } }]
        : []),
    ],
  };
}

/**
 * HASTA CUÁNDO OCUPA UNA RESERVA DE VERDAD.
 *
 * No es siempre su fecha de fin. Un auto que salió y no volvió sigue ocupado
 * HOY aunque la reserva venciera anteayer: la fecha de fin es una promesa, y la
 * promesa se puede incumplir. Mientras el auto no esté devuelto, prometerlo
 * para mañana es prometer algo que no se tiene.
 *
 * Por eso el fin efectivo de una reserva sin devolver es el más lejano entre su
 * fecha de fin y hoy, y crece un día por día hasta que alguien confirma la
 * devolución. Ahí la reserva pasa a COMPLETED y suelta todo de una.
 *
 * Mientras la reserva está en fecha no cambia nada: un alquiler del 1 al 10 no
 * bloquea el 15 por estar en curso, que sería lo contrario de lo que se quiere.
 */
function effectiveEnd(
  booking: { endDate: Date; status: BookingStatus },
  hoy: Date,
): Date {
  if (!sinDevolverStatuses.includes(booking.status)) return booking.endDate;
  return booking.endDate.getTime() >= hoy.getTime() ? booking.endDate : hoy;
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

    /*
      Los días que ocupa cada reserva se calculan con su fin EFECTIVO, no con
      la fecha que dice. Una que salió y no volvió ocupa hasta hoy, y el
      calendario tiene que pintar esos días: si la consulta los devuelve
      ocupados pero el calendario los muestra libres, alguien los elige, el
      servidor le dice que no, y el error no se entiende desde ninguna parte.
    */
    const hoy = startOfUtcDay(new Date());
    const ocupaciones = bookings.map((b) => ({
      startDate: b.startDate,
      endDate: effectiveEnd(b, hoy),
    }));

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
        [...ocupaciones, ...manualBlocks],
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

  calculateDays(startDate: Date, endDate: Date) {
    const milliseconds = endDate.getTime() - startDate.getTime();
    return Math.ceil(milliseconds / (1000 * 60 * 60 * 24));
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
      ...occupiedBookingWhere(startDate, endDate),
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
