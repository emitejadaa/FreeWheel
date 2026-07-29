import { overlappingRangeWhere } from "./availability.service";

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
