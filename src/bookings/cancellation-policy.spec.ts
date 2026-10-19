import { BookingStatus } from "@prisma/client";
import {
  decidirCancelacion,
  ladoDelNoShow,
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

/*
  ── LAS DOS CONSTANCIAS ────────────────────────────────────────────────────

  El retiro es el único momento del alquiler que pasa en la vereda y que el
  servidor no puede ver. Si nadie escaneó el código, lo único que hay son dos
  personas diciendo cada una que la otra no fue.

  Hasta acá solo el dueño podía dejar constancia, así que su versión era la
  única escrita que existía: alcanzaba con reportar para quedarse con la seña,
  sin nada que la contradijera. Ahora las dos partes pueden, y de las CUATRO
  combinaciones TRES se resuelven solas.

  Esta es la tabla entera. Es la prueba que importa de todo el archivo: cada
  fila es una forma distinta en que puede terminar un retiro que no pasó, y
  ninguna puede quedar sin decidir ni decidida de dos maneras.
*/
describe("las cuatro combinaciones del retiro que no paso", () => {
  const CINCO_HORAS_DESPUES = new Date(INICIO.getTime() + 5 * 60 * 60 * 1000);

  const conConstancias = (opciones: {
    elDuenoReporto?: boolean;
    quienAlquiloReporto?: boolean;
    laCancelaElDueno?: boolean;
    resueltoAFavorDe?: "OWNER" | "RENTER" | null;
  }) =>
    decidirCancelacion({
      status: BookingStatus.READY_FOR_PICKUP,
      startDate: INICIO,
      ahora: CINCO_HORAS_DESPUES,
      laCancelaElDueno: opciones.laCancelaElDueno ?? false,
      entregaConfirmada: false,
      noAparecioElInquilino: opciones.elDuenoReporto ?? false,
      noAparecioElDueno: opciones.quienAlquiloReporto ?? false,
      resueltoAFavorDe: opciones.resueltoAFavorDe ?? null,
    });

  it("NINGUNO DE LOS DOS: vuelve todo, el silencio no paga", () => {
    const d = conConstancias({});
    expect(d.puede).toBe(true);
    expect(d.tier).toBe("nadieAparecio");
    expect(d.retieneSena).toBe(false);
  });

  it("SOLO EL DUEÑO: la seña queda para el, fue y lo asento", () => {
    const d = conConstancias({ elDuenoReporto: true });
    expect(d.puede).toBe(true);
    expect(d.tier).toBe("tardia");
    expect(d.retieneSena).toBe(true);
  });

  it("SOLO QUIEN ALQUILO: vuelve todo, y queda con nombre que el dueño falto", () => {
    /*
      En plata es lo mismo que si nadie hubiera hablado, y es a propósito: lo
      que agrega esta constancia es el NOMBRE. Un dueño que falta y nadie lo
      dice se parece demasiado a un dueño que no falta.
    */
    const d = conConstancias({ quienAlquiloReporto: true });
    expect(d.puede).toBe(true);
    expect(d.tier).toBe("nadieAparecio");
    expect(d.retieneSena).toBe(false);
  });

  it("LOS DOS: NO SE MUEVE NADA hasta que alguien lo resuelva", () => {
    const d = conConstancias({
      elDuenoReporto: true,
      quienAlquiloReporto: true,
    });
    expect(d.puede).toBe(false);
    expect(d.motivo).toBe("NO_SHOW_DISPUTED");
    expect(d.tier).toBe("disputa");
    // No retiene la seña NI la devuelve: la plata se queda donde está.
    expect(d.retieneSena).toBe(false);
  });

  it("Y EL DUEÑO ACUSADO NO SE DESTRABA CANCELANDO EL", () => {
    /*
      EL AGUJERO QUE ESTO TAPA, Y QUE NO ES OBVIO.

      "Si cancela el dueño vuelve todo" suena a que siempre juega en contra del
      dueño, así que parece inofensivo dejarlo ganar sobre la disputa. No lo
      es: al dueño que reportó en falso le alcanzaría con cancelar él para
      cerrar el caso y hacer desaparecer la discusión sobre la seña sin que
      nadie la mire. La plata que resigna es la que de todos modos no le
      correspondía; lo que se lleva gratis es el expediente.

      Por eso el caso trabado se decide ANTES que cualquier otra cosa.
    */
    const d = conConstancias({
      elDuenoReporto: true,
      quienAlquiloReporto: true,
      laCancelaElDueno: true,
    });
    expect(d.puede).toBe(false);
    expect(d.motivo).toBe("NO_SHOW_DISPUTED");
  });

  it("resuelto a favor del dueño: la seña queda para el", () => {
    const d = conConstancias({
      elDuenoReporto: true,
      quienAlquiloReporto: true,
      resueltoAFavorDe: "OWNER",
    });
    expect(d.puede).toBe(true);
    expect(d.tier).toBe("tardia");
    expect(d.retieneSena).toBe(true);
  });

  it("resuelto a favor de quien alquilo: vuelve todo", () => {
    const d = conConstancias({
      elDuenoReporto: true,
      quienAlquiloReporto: true,
      resueltoAFavorDe: "RENTER",
    });
    expect(d.puede).toBe(true);
    expect(d.tier).toBe("nadieAparecio");
    expect(d.retieneSena).toBe(false);
  });

  it("UN VALOR RARO EN LA DECISION DEJA EL CASO TRABADO, no lo resuelve solo", () => {
    /*
      La decisión se guarda en una columna de texto. Si alguna vez llega ahí
      algo que no es ninguno de los dos lados —un dato tocado a mano, un typo
      en código nuevo— lo que NO puede pasar es que el caso se destrabe solo y
      la plata se mueva. Se trata como "todavía no se decidió", que es el lado
      seguro. Ver ladoDelNoShow.
    */
    expect(ladoDelNoShow("OWNER")).toBe("OWNER");
    expect(ladoDelNoShow("RENTER")).toBe("RENTER");
    for (const basura of ["owner", "AMBOS", "", null, undefined]) {
      expect(ladoDelNoShow(basura)).toBeNull();
    }
    const d = conConstancias({
      elDuenoReporto: true,
      quienAlquiloReporto: true,
      resueltoAFavorDe: ladoDelNoShow("cualquier cosa"),
    });
    expect(d.motivo).toBe("NO_SHOW_DISPUTED");
  });
});

describe("la ventana es LA MISMA para los dos lados", () => {
  /*
    No hay una función para el dueño y otra para quien alquiló: es la misma, y
    eso es lo que garantiza que ninguno de los dos tenga un plazo más cómodo.
    Una regla asimétrica acá sería ponerle el pulgar a la balanza antes de que
    empiece la discusión.
  */
  it("sobre una reserva ya cerrada no se reporta nada", () => {
    /*
      Llegando tarde, el reporte no cambia plata —ya se repartió— y lo único
      que haría es dejar una acusación en el registro cuando no hay nada que
      decidir.
    */
    const r = puedeReportarNoShow({
      status: BookingStatus.CANCELLED_BY_RENTER,
      startDate: INICIO,
      ahora: new Date(INICIO.getTime() + 60 * 60 * 1000),
      entregaConfirmada: false,
    });
    expect(r).toEqual({ puede: false, motivo: "BOOKING_NOT_CANCELLABLE" });
  });

  it("y sobre una viva, con los mismos plazos de siempre", () => {
    const enMinutos = (m: number) =>
      puedeReportarNoShow({
        status: BookingStatus.READY_FOR_PICKUP,
        startDate: INICIO,
        ahora: new Date(INICIO.getTime() + m * 60 * 1000),
        entregaConfirmada: false,
      });
    expect(enMinutos(MINUTOS_DE_GRACIA_EN_EL_RETIRO - 1).motivo).toBe(
      "TOO_EARLY_FOR_NO_SHOW",
    );
    expect(enMinutos(MINUTOS_DE_GRACIA_EN_EL_RETIRO).puede).toBe(true);
    expect(enMinutos(HORAS_PARA_RECLAMAR_NO_SHOW * 60 + 1).motivo).toBe(
      "NO_SHOW_WINDOW_CLOSED",
    );
  });
});
