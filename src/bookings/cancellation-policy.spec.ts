import { BookingStatus } from "@prisma/client";
import { decidirCancelacion, HORAS_DE_GRACIA } from "./cancellation-policy";

/**
 * Las fechas están elegidas a mano y "ahora" entra por parámetro: una prueba de
 * plazos atada al reloj de la máquina pasa hoy y falla mañana.
 */
const INICIO = new Date("2026-10-10T12:00:00.000Z");
const horasAntes = (h: number) =>
  new Date(INICIO.getTime() - h * 60 * 60 * 1000);

const decidir = (
  ahora: Date,
  status: BookingStatus = BookingStatus.ACCEPTED,
  laCancelaElDueno = false,
) => decidirCancelacion({ status, startDate: INICIO, ahora, laCancelaElDueno });

describe("decidirCancelacion", () => {
  it("con tiempo de sobra vuelve todo", () => {
    const d = decidir(horasAntes(72));
    expect(d.puede).toBe(true);
    expect(d.tier).toBe("libre");
    expect(d.retieneSena).toBe(false);
  });

  it("justo en el límite todavía es libre", () => {
    // El límite cuenta a favor de quien cancela: a las 48 horas exactas
    // todavía entra. Un borde que cae del otro lado convierte un plazo claro
    // en una lotería de segundos.
    const d = decidir(horasAntes(HORAS_DE_GRACIA));
    expect(d.tier).toBe("libre");
    expect(d.retieneSena).toBe(false);
  });

  it("un minuto después del límite ya retiene la seña", () => {
    const d = decidir(horasAntes(HORAS_DE_GRACIA - 0.02));
    expect(d.tier).toBe("tardia");
    expect(d.retieneSena).toBe(true);
  });

  it("la noche anterior retiene la seña", () => {
    /*
      El caso que motivó todo esto. Sin política, alguien tenía un auto
      bloqueado un mes, lo soltaba el día anterior sin costo, y el dueño se
      quedaba sin el alquiler Y sin las fechas, porque nadie más las pudo
      reservar en todo ese tiempo.
    */
    const d = decidir(horasAntes(10));
    expect(d.puede).toBe(true);
    expect(d.tier).toBe("tardia");
    expect(d.retieneSena).toBe(true);
  });

  it("EL DUEÑO QUE SE BAJA DEVUELVE TODO, y en cualquier momento", () => {
    // No hay plazo que lo mejore: quien deja a la otra persona sin auto no se
    // queda además con su plata.
    for (const horas of [200, 48, 10, 1]) {
      const d = decidir(horasAntes(horas), BookingStatus.ACCEPTED, true);
      expect(d.tier).toBe("delDueno");
      expect(d.retieneSena).toBe(false);
    }
  });

  it("una reserva que todavía no aceptaron se cancela igual", () => {
    // Ahí no hay nada pagado, así que la política no cobra nada; lo que
    // importa es que se pueda.
    expect(decidir(horasAntes(3), BookingStatus.REQUESTED).puede).toBe(true);
  });

  it("con el auto afuera NO se cancela, y se dice por qué", () => {
    /*
      No es lo mismo que una reserva cerrada: el auto está en la calle y la
      salida existe, solo que no es cancelar, es devolverlo. Con un "no se
      puede" a secas, alguien escribe a soporte por algo que puede hacer solo.
    */
    for (const status of [
      BookingStatus.IN_PROGRESS,
      BookingStatus.RETURN_PENDING,
    ]) {
      const d = decidir(horasAntes(-5), status);
      expect(d.puede).toBe(false);
      expect(d.motivo).toBe("BOOKING_IN_PROGRESS");
    }
  });

  it("una reserva ya terminada o ya cancelada tampoco", () => {
    for (const status of [
      BookingStatus.COMPLETED,
      BookingStatus.CANCELLED_BY_RENTER,
      BookingStatus.CANCELLED_BY_OWNER,
      BookingStatus.REJECTED,
    ]) {
      const d = decidir(horasAntes(-100), status);
      expect(d.puede).toBe(false);
      expect(d.motivo).toBe("BOOKING_NOT_CANCELLABLE");
    }
  });

  it("y el dueño tampoco puede cancelar algo que ya empezó", () => {
    // La excepción del dueño es sobre el PRECIO, no sobre el estado: con el
    // auto afuera no hay nada que cancelar, lo haya pedido quien lo haya
    // pedido.
    const d = decidir(horasAntes(-5), BookingStatus.IN_PROGRESS, true);
    expect(d.puede).toBe(false);
  });

  it("dice cuántas horas faltan, para poder avisarlo", () => {
    // Es lo que permite escribir "te quedan 6 horas para cancelar sin costo"
    // en vez de un plazo abstracto.
    expect(decidir(horasAntes(54)).horasParaElInicio).toBeCloseTo(54, 5);
    expect(decidir(horasAntes(-2)).horasParaElInicio).toBeCloseTo(-2, 5);
  });
});
