import { BookingStatus } from "@prisma/client";
import {
  decidirCancelacion,
  puedeReportarNoShow,
  HORAS_DE_GRACIA,
  HORAS_PARA_RECLAMAR_NO_SHOW,
  MINUTOS_DE_GRACIA_EN_EL_RETIRO,
} from "./cancellation-policy";

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

/*
  EL QUE NO APARECE NO COBRA

  El agujero: el dueño aceptaba, cobraba y no iba. La persona cancelaba después
  de la hora y la regla la trataba como una cancelación tardía cualquiera:
  perdía la seña, y esa seña iba al dueño. No aparecer pagaba el 30%.

  La regla nueva no intenta adivinar quién faltó —el servidor no ve la vereda—.
  Mira si hay CONSTANCIA de que el auto se entregó. Si no la hay, nadie cobra
  por una entrega que nadie puede demostrar.

  Y la otra mitad: el dueño que sí fue puede dejar su propia constancia, dentro
  de una ventana. Así lo hace Turo.
*/
describe("el que no aparece no cobra", () => {
  const minutosDespues = (m: number) =>
    new Date(INICIO.getTime() + m * 60 * 1000);
  const horasDespues = (h: number) => minutosDespues(h * 60);

  const trasElInicio = (opciones: {
    minutos: number;
    entregaConfirmada?: boolean;
    noAparecioElInquilino?: boolean;
    laCancelaElDueno?: boolean;
  }) =>
    decidirCancelacion({
      status: BookingStatus.READY_FOR_PICKUP,
      startDate: INICIO,
      ahora: minutosDespues(opciones.minutos),
      laCancelaElDueno: opciones.laCancelaElDueno ?? false,
      entregaConfirmada: opciones.entregaConfirmada ?? false,
      noAparecioElInquilino: opciones.noAparecioElInquilino ?? false,
    });

  it("PASADA LA HORA SIN ENTREGA CONFIRMADA, VUELVE TODO", () => {
    const d = trasElInicio({ minutos: MINUTOS_DE_GRACIA_EN_EL_RETIRO + 1 });
    expect(d.puede).toBe(true);
    expect(d.tier).toBe("nadieAparecio");
    expect(d.retieneSena).toBe(false);
  });

  it("y sigue volviendo todo un dia despues", () => {
    expect(trasElInicio({ minutos: 60 * 24 }).tier).toBe("nadieAparecio");
  });

  it("DENTRO DE LA GRACIA TODAVIA NO: un atraso no es un planton", () => {
    // Media hora, como Turo. El transito, el colectivo, no encontrar la esquina.
    const d = trasElInicio({ minutos: MINUTOS_DE_GRACIA_EN_EL_RETIRO - 5 });
    expect(d.tier).toBe("tardia");
    expect(d.retieneSena).toBe(true);
  });

  it("justo en la gracia ya cuenta, y a favor de quien cancela", () => {
    expect(trasElInicio({ minutos: MINUTOS_DE_GRACIA_EN_EL_RETIRO }).tier).toBe(
      "nadieAparecio",
    );
  });

  it("CON LA ENTREGA CONFIRMADA NO APLICA: el auto se entrego", () => {
    // Si alguien escaneó el código, la entrega pasó y esta regla no tiene nada
    // que hacer ahí.
    const d = trasElInicio({ minutos: 60 * 5, entregaConfirmada: true });
    expect(d.tier).toBe("tardia");
    expect(d.retieneSena).toBe(true);
  });

  it("CON EL REPORTE DEL DUEÑO VUELVE A SER TARDIA: el si fue", () => {
    const d = trasElInicio({ minutos: 60 * 5, noAparecioElInquilino: true });
    expect(d.tier).toBe("tardia");
    expect(d.retieneSena).toBe(true);
  });

  it("antes del inicio nada de esto cambia", () => {
    // La regla de las 48 horas sigue mandando antes de la hora acordada.
    expect(decidir(horasAntes(72)).tier).toBe("libre");
    expect(decidir(horasAntes(2)).tier).toBe("tardia");
  });

  it("si cancela el dueño sigue volviendo todo, pase lo que pase", () => {
    const d = trasElInicio({
      minutos: 60 * 5,
      laCancelaElDueno: true,
      noAparecioElInquilino: true,
    });
    expect(d.tier).toBe("delDueno");
    expect(d.retieneSena).toBe(false);
  });

  it("una reserva en curso sigue sin cancelarse: se devuelve el auto", () => {
    const d = decidirCancelacion({
      status: BookingStatus.IN_PROGRESS,
      startDate: INICIO,
      ahora: horasDespues(5),
      laCancelaElDueno: false,
    });
    expect(d.puede).toBe(false);
    expect(d.motivo).toBe("BOOKING_IN_PROGRESS");
  });
});

describe("la ventana para reportar que la persona no aparecio", () => {
  const enMinutos = (m: number) =>
    puedeReportarNoShow({
      startDate: INICIO,
      ahora: new Date(INICIO.getTime() + m * 60 * 1000),
      entregaConfirmada: false,
    });

  it("ANTES DE LA GRACIA NO SE PUEDE: la persona puede estar llegando", () => {
    expect(enMinutos(0).puede).toBe(false);
    expect(enMinutos(MINUTOS_DE_GRACIA_EN_EL_RETIRO - 1).motivo).toBe(
      "TOO_EARLY_FOR_NO_SHOW",
    );
  });

  it("desde la gracia si", () => {
    expect(enMinutos(MINUTOS_DE_GRACIA_EN_EL_RETIRO).puede).toBe(true);
    expect(enMinutos(60 * 6).puede).toBe(true);
  });

  it("PASADA LA VENTANA NO SE PUEDE, y eso tambien cuida a alguien", () => {
    /*
      Sin plazo, el dueño podría esperar a ver si le conviene y recién entonces
      reclamar la seña. Y un reporte hecho tres días después ya no lo puede
      discutir nadie, porque nadie se acuerda.
    */
    expect(enMinutos(HORAS_PARA_RECLAMAR_NO_SHOW * 60 + 1).puede).toBe(false);
    expect(enMinutos(HORAS_PARA_RECLAMAR_NO_SHOW * 60 + 1).motivo).toBe(
      "NO_SHOW_WINDOW_CLOSED",
    );
  });

  it("CON LA ENTREGA CONFIRMADA NUNCA: no hay nada que reportar", () => {
    expect(
      puedeReportarNoShow({
        startDate: INICIO,
        ahora: new Date(INICIO.getTime() + 60 * 60 * 1000),
        entregaConfirmada: true,
      }),
    ).toEqual({ puede: false, motivo: "PICKUP_ALREADY_CONFIRMED" });
  });
});
