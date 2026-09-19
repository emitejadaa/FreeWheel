import { BookingStatus } from "@prisma/client";
import {
  AvailabilityService,
  occupiedBookingWhere,
  overlappingRangeWhere,
} from "./availability.service";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * ¿Una ocupación guardada (reserva o bloqueo) cae dentro de la ventana pedida?
 *
 * Aplica a mano la condición que armó overlappingRangeWhere, que es la que Prisma
 * traduce a SQL. Así se puede probar la regla sin base de datos.
 */
function overlaps(
  saved: { startDate: string; endDate: string },
  query: { from: string; to: string },
): boolean {
  const where = overlappingRangeWhere(
    new Date(`${query.from}T00:00:00.000Z`),
    new Date(`${query.to}T00:00:00.000Z`),
  );
  const start = new Date(`${saved.startDate}T00:00:00.000Z`);
  const end = new Date(`${saved.endDate}T00:00:00.000Z`);
  return start < where.startDate.lt && end >= where.endDate.gte;
}

describe("overlappingRangeWhere", () => {
  // El auto está reservado del 30 de julio al 4 de agosto.
  const booking = { startDate: "2026-07-30", endDate: "2026-08-04" };

  it("detecta la ocupación cuando se busca un solo día (del 30 al 30)", () => {
    // Éste es el caso que estaba mal: la publicación aparecía como disponible
    // aunque el panel del auto mostrara el 30 de julio como ocupado.
    expect(overlaps(booking, { from: "2026-07-30", to: "2026-07-30" })).toBe(
      true,
    );
  });

  it("detecta la ocupación en cualquier día del medio", () => {
    expect(overlaps(booking, { from: "2026-08-01", to: "2026-08-01" })).toBe(
      true,
    );
    expect(overlaps(booking, { from: "2026-07-28", to: "2026-08-10" })).toBe(
      true,
    );
  });

  it("cuenta el día de devolución como ocupado", () => {
    // Vuelve el 4: ese día todavía no se puede volver a alquilar.
    expect(overlaps(booking, { from: "2026-08-04", to: "2026-08-04" })).toBe(
      true,
    );
  });

  it("deja libres los días de antes y de después", () => {
    expect(overlaps(booking, { from: "2026-07-29", to: "2026-07-29" })).toBe(
      false,
    );
    expect(overlaps(booking, { from: "2026-08-05", to: "2026-08-07" })).toBe(
      false,
    );
  });

  it("ignora la hora: importa el día completo", () => {
    const withTime = { startDate: "2026-07-30", endDate: "2026-08-04" };
    const where = overlappingRangeWhere(
      new Date("2026-07-30T18:30:00.000Z"),
      new Date("2026-07-30T09:15:00.000Z"),
    );
    const start = new Date(`${withTime.startDate}T00:00:00.000Z`);
    const end = new Date(`${withTime.endDate}T00:00:00.000Z`);
    expect(start < where.startDate.lt && end >= where.endDate.gte).toBe(true);
  });
});

describe("occupiedBookingWhere", () => {
  const dia = (texto: string) => new Date(`${texto}T00:00:00.000Z`);

  /**
   * ¿Esta reserva ocupa la ventana pedida?
   *
   * Aplica a mano las dos ramas que arma occupiedBookingWhere, que son las que
   * Prisma traduce a SQL. Igual que el helper de arriba: la regla se prueba sin
   * base de datos.
   */
  function ocupa(
    reserva: { startDate: string; endDate: string; status: BookingStatus },
    ventana: { from: string; to: string },
    hoy: string,
  ): boolean {
    const where = occupiedBookingWhere(
      dia(ventana.from),
      dia(ventana.to),
      dia(hoy),
    );
    const start = dia(reserva.startDate);
    const end = dia(reserva.endDate);
    return where.OR.some((rama) => {
      const conFin = rama as { endDate?: { gte: Date } };
      if (!rama.status.in.includes(reserva.status)) return false;
      if (!(start < rama.startDate.lt)) return false;
      if (conFin.endDate && !(end >= conFin.endDate.gte)) return false;
      return true;
    });
  }

  // Alquilado del 1 al 10 de agosto.
  const delUnoAlDiez = { startDate: "2026-08-01", endDate: "2026-08-10" };

  it("un alquiler EN FECHA no bloquea los días de después", () => {
    // Lo de siempre, y lo que no tiene que cambiar: estando en curso el 5, el
    // auto se puede seguir reservando para el 15. Bloquear el futuro entero
    // por tener un alquiler andando sería peor que el problema.
    const enCurso = { ...delUnoAlDiez, status: BookingStatus.IN_PROGRESS };
    expect(
      ocupa(enCurso, { from: "2026-08-15", to: "2026-08-20" }, "2026-08-05"),
    ).toBe(false);
    expect(
      ocupa(enCurso, { from: "2026-08-05", to: "2026-08-05" }, "2026-08-05"),
    ).toBe(true);
  });

  it("un auto que no volvió sigue ocupado HOY, aunque la reserva haya vencido", () => {
    /*
      El agujero que esto vino a tapar. La reserva terminaba el 10 y nadie
      confirmó la devolución: el auto está afuera. Con la regla vieja, el 12
      figuraba libre y el dueño podía tener dos personas esperando el mismo
      auto, que es el peor lugar donde puede aparecer este error.
    */
    const sinDevolver = { ...delUnoAlDiez, status: BookingStatus.IN_PROGRESS };
    expect(
      ocupa(
        sinDevolver,
        { from: "2026-08-12", to: "2026-08-12" },
        "2026-08-12",
      ),
    ).toBe(true);
    expect(
      ocupa(
        sinDevolver,
        { from: "2026-08-11", to: "2026-08-14" },
        "2026-08-14",
      ),
    ).toBe(true);
  });

  it("y la que espera la confirmación del dueño cuenta igual", () => {
    const esperando = { ...delUnoAlDiez, status: BookingStatus.RETURN_PENDING };
    expect(
      ocupa(esperando, { from: "2026-08-12", to: "2026-08-12" }, "2026-08-12"),
    ).toBe(true);
  });

  it("DEVOLVER ANTES libera las fechas que sobran", () => {
    /*
      El caso que pidió esto: se alquila el mes entero y se devuelve a las dos
      semanas porque quien alquiló se tiene que ir. Confirmada la devolución la
      reserva queda COMPLETED, y ahí deja de ocupar: el dueño recupera las dos
      semanas que quedan en vez de mirarlas bloqueadas hasta fin de mes.

      Las fechas guardadas en la reserva no se tocan, que es lo correcto: son
      las que se pagaron y las que tiene que decir el comprobante.
    */
    const devuelta = {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      status: BookingStatus.COMPLETED,
    };
    expect(
      ocupa(devuelta, { from: "2026-08-20", to: "2026-08-25" }, "2026-08-15"),
    ).toBe(false);
    // Ni siquiera los días que efectivamente se usó: ya pasaron y no ocupan nada.
    expect(
      ocupa(devuelta, { from: "2026-08-05", to: "2026-08-05" }, "2026-08-15"),
    ).toBe(false);
  });

  it("una cancelada nunca ocupó nada", () => {
    const cancelada = {
      ...delUnoAlDiez,
      status: BookingStatus.CANCELLED_BY_RENTER,
    };
    expect(
      ocupa(cancelada, { from: "2026-08-05", to: "2026-08-05" }, "2026-08-05"),
    ).toBe(false);
  });

  it("una reserva aceptada a futuro ocupa como siempre", () => {
    const aceptada = { ...delUnoAlDiez, status: BookingStatus.ACCEPTED };
    expect(
      ocupa(aceptada, { from: "2026-08-03", to: "2026-08-03" }, "2026-07-20"),
    ).toBe(true);
    expect(
      ocupa(aceptada, { from: "2026-08-10", to: "2026-08-10" }, "2026-07-20"),
    ).toBe(true);
    expect(
      ocupa(aceptada, { from: "2026-08-11", to: "2026-08-11" }, "2026-07-20"),
    ).toBe(false);
  });

  it("preguntando por una ventana que terminó antes de hoy, el auto afuera no la ocupa", () => {
    // El fin efectivo de una reserva sin devolver es HOY: no puede ocupar hacia
    // atrás más de lo que dice su propia fecha de fin.
    const sinDevolver = { ...delUnoAlDiez, status: BookingStatus.IN_PROGRESS };
    expect(
      ocupa(
        sinDevolver,
        { from: "2026-07-20", to: "2026-07-25" },
        "2026-08-20",
      ),
    ).toBe(false);
  });
});

describe("assertDateRange", () => {
  const service = new AvailabilityService({} as PrismaService);

  // "Ahora" fijo en un punto avanzado del día, para probar justo el caso
  // reportado: a las 16:40 del 29 de julio, ese mismo día no puede alquilarse.
  const NOW = new Date("2026-07-29T16:40:00.000Z");

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("rechaza el día de hoy como inicio, sin importar la hora", () => {
    // Antes esto pasaba: comparaba contra el instante actual, así que una
    // reserva para más tarde el mismo día quedaba permitida.
    expect(() =>
      service.assertDateRange(
        new Date("2026-07-29T20:00:00.000Z"),
        new Date("2026-07-30T20:00:00.000Z"),
      ),
    ).toThrow(/at least tomorrow/);
  });

  it("rechaza el día de hoy incluso a primera hora de la madrugada", () => {
    expect(() =>
      service.assertDateRange(
        new Date("2026-07-29T00:00:01.000Z"),
        new Date("2026-07-30T00:00:00.000Z"),
      ),
    ).toThrow(/at least tomorrow/);
  });

  it("acepta mañana como el primer día posible", () => {
    expect(() =>
      service.assertDateRange(
        new Date("2026-07-30T00:00:00.000Z"),
        new Date("2026-07-31T00:00:00.000Z"),
      ),
    ).not.toThrow();
  });

  it("sigue rechazando fechas realmente pasadas", () => {
    expect(() =>
      service.assertDateRange(
        new Date("2026-07-01T00:00:00.000Z"),
        new Date("2026-07-02T00:00:00.000Z"),
      ),
    ).toThrow(/at least tomorrow/);
  });

  it("con allowPast permite consultar disponibilidad desde hoy", () => {
    // La consulta de disponibilidad (no la creación de una reserva) sí puede
    // mirar desde hoy: es de solo lectura, no reserva nada.
    expect(() =>
      service.assertDateRange(
        new Date("2026-07-29T00:00:00.000Z"),
        new Date("2026-08-01T00:00:00.000Z"),
        { allowPast: true },
      ),
    ).not.toThrow();
  });
});
