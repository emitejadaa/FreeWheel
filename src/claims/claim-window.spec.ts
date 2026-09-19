import { BookingStatus } from "@prisma/client";
import { estadoDeLaRevision, HORAS_DE_REVISION } from "./claim-window";

const DEVUELTO = new Date("2026-10-10T18:00:00.000Z");
const horasDespues = (h: number) =>
  new Date(DEVUELTO.getTime() + h * 60 * 60 * 1000);

const estado = (
  horas: number,
  extra: {
    status?: BookingStatus;
    hayReclamoAbierto?: boolean;
    returnConfirmedAt?: Date | null;
  } = {},
) =>
  estadoDeLaRevision({
    status: extra.status ?? BookingStatus.COMPLETED,
    returnConfirmedAt:
      extra.returnConfirmedAt === undefined
        ? DEVUELTO
        : extra.returnConfirmedAt,
    hayReclamoAbierto: extra.hayReclamoAbierto ?? false,
    ahora: horasDespues(horas),
  });

describe("estadoDeLaRevision", () => {
  it("recién devuelto, el dueño puede reclamar y el depósito no se suelta", () => {
    /*
      Es el punto de todo esto: si el depósito se soltara al confirmarse la
      devolución, cuando el dueño se acerca al auto y ve el golpe ya no habría
      retención que capturar. El depósito serviría para todo menos para lo
      único que existe.
    */
    const e = estado(1);
    expect(e.abierta).toBe(true);
    expect(e.sePuedeLiberar).toBe(false);
  });

  it("pasadas las 48 horas sin reclamo, se suelta", () => {
    const e = estado(HORAS_DE_REVISION + 0.1);
    expect(e.abierta).toBe(false);
    expect(e.sePuedeLiberar).toBe(true);
  });

  it("justo en el límite la ventana todavía está abierta", () => {
    // El borde cuenta a favor del dueño, que es quien está mirando el auto.
    const e = estado(HORAS_DE_REVISION - 0.01);
    expect(e.abierta).toBe(true);
    expect(e.sePuedeLiberar).toBe(false);
  });

  it("UN RECLAMO ABIERTO CONGELA EL DEPÓSITO, aunque la ventana venza", () => {
    /*
      Soltarlo por el solo paso del tiempo sería resolver el reclamo a favor de
      una de las partes sin decirlo. La ventana es para ABRIR el reclamo, no
      para resolverlo: eso lo hace un administrador.
    */
    for (const horas of [1, 49, 240]) {
      const e = estado(horas, { hayReclamoAbierto: true });
      expect(e.sePuedeLiberar).toBe(false);
      // Y tampoco se puede abrir otro encima del que ya está.
      expect(e.abierta).toBe(false);
    }
  });

  it("con el auto todavía afuera no hay ventana ni liberación", () => {
    for (const status of [
      BookingStatus.IN_PROGRESS,
      BookingStatus.RETURN_PENDING,
      BookingStatus.ACCEPTED,
    ]) {
      const e = estado(1, { status, returnConfirmedAt: null });
      expect(e.abierta).toBe(false);
      expect(e.sePuedeLiberar).toBe(false);
      expect(e.vence).toBeNull();
    }
  });

  it("una reserva COMPLETED sin fecha de devolución no abre nada", () => {
    // No debería existir, pero si existe lo correcto es no soltar plata por un
    // dato que falta.
    const e = estado(1, { returnConfirmedAt: null });
    expect(e.sePuedeLiberar).toBe(false);
  });

  it("dice cuándo vence y cuánto queda, para poder avisarlo", () => {
    const e = estado(6);
    expect(e.vence?.toISOString()).toBe("2026-10-12T18:00:00.000Z");
    expect(e.horasQueQuedan).toBeCloseTo(42, 5);
    expect(estado(60).horasQueQuedan).toBeCloseTo(-12, 5);
  });
});
