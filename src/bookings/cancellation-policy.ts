import { BookingStatus } from "@prisma/client";

/**
 * cancellation-policy.ts — Hasta cuándo se puede cancelar, y qué vuelve
 * ---------------------------------------------------------------------------
 * POR QUÉ EXISTE: hasta ahora cancelar devolvía el CIEN POR CIENTO en
 * cualquier momento, hasta el minuto anterior al retiro. Eso suena generoso y
 * es un agujero: alguien podía tener un auto bloqueado un mes entero, soltarlo
 * el día anterior sin costo, y el dueño se quedaba sin el alquiler Y sin las
 * fechas, porque nadie más las pudo reservar en todo ese tiempo.
 *
 * Una política de cancelación no está para castigar a quien cancela. Está para
 * que las dos partes sepan de antemano qué pasa, que es lo único que permite
 * planificar. Por eso esto es una regla escrita y no un criterio.
 *
 * ── LA POLÍTICA ───────────────────────────────────────────────────────────
 *
 *   · Hasta 48 horas antes del inicio → vuelve TODO.
 *   · Entre las 48 horas y el inicio  → vuelve el saldo, se retiene la seña.
 *   · Después del retiro              → no se cancela. El auto está afuera y
 *                                       lo que corresponde es devolverlo.
 *   · Si cancela el DUEÑO             → vuelve todo, siempre y en cualquier
 *                                       momento. El que incumple no se queda
 *                                       con nada.
 *   · Si pasó la hora y NADIE          → vuelve todo. Ver abajo: es la regla
 *     confirmó la entrega                que hace que no aparecer no pague.
 *
 * El depósito en garantía se suelta en todos los casos: nunca fue un cobro.
 *
 * ── POR QUÉ 48 HORAS Y POR QUÉ LA SEÑA ────────────────────────────────────
 * 48 horas es el plazo estándar de las empresas de alquiler, y no es
 * arbitrario: es el tiempo que le deja al dueño una chance real de volver a
 * alquilar esas fechas. Cancelar con dos días es un cambio de planes; cancelar
 * la noche anterior es dejar a alguien sin poder hacer nada.
 *
 * Y lo retenido es la seña y no un porcentaje inventado porque la seña YA es
 * eso: el 30% que se paga por adelantado justamente para reservar las fechas.
 * Perder la reserva es perder la seña, que es lo que cualquiera entiende sin
 * que se lo expliquen.
 *
 * ── EL QUE NO APARECE NO COBRA ────────────────────────────────────────────
 *
 * El agujero que esto tapa: el dueño aceptaba, cobraba y simplemente NO IBA.
 * La persona se quedaba sin auto, y si cancelaba después de la hora de inicio
 * la regla de arriba la trataba como una cancelación tardía cualquiera: perdía
 * la seña, y esa seña iba al dueño. O sea que no aparecer PAGABA el 30%.
 *
 * Así lo resuelven las plataformas que ya pasaron por esto. Turo da media hora
 * de gracia desde el horario acordado: si el dueño no canceló ni apareció, la
 * persona recibe todo de vuelta. Airbnb hace lo mismo cuando el anfitrión se
 * cae: devolución total y el anfitrión no cobra nada.
 *
 * LA REGLA, Y POR QUÉ NO NECESITA QUE NADIE DECIDA:
 *
 * Pasada la hora de inicio más la gracia, si NADIE confirmó la entrega, la
 * cancelación devuelve todo. No hace falta saber quién faltó, y es a propósito
 * que no se intente adivinarlo: el servidor no puede ver la vereda.
 *
 * Lo que sí sabe, y alcanza, es QUIÉN PODÍA DEJAR CONSTANCIA. La entrega la
 * confirma el dueño escaneando el código. Si no hay constancia de que el auto
 * se entregó, quien tenía el aparato para registrarlo y no lo usó no puede
 * cobrar por una entrega que nadie puede demostrar. Es la misma idea que en
 * cualquier reclamo: la carga la lleva el que estaba en condiciones de probar.
 *
 * Y el efecto es el que importa: NO APARECER NUNCA PAGA. Sin premio, la estafa
 * deja de tener sentido, que es lo más cerca de "no se puede estafar" a lo que
 * se puede llegar sin poner a alguien a mirar.
 *
 * ── ENTONCES, ¿EL INQUILINO QUE NO VA SE LLEVA TODO GRATIS? ───────────────
 *
 * No, y acá está la otra mitad. El dueño que SÍ fue puede dejar su propia
 * constancia: reportar que la persona no apareció. Es un acto con nombre,
 * fecha y hora, que queda en el registro de auditoría, y solo se puede hacer
 * en una ventana —desde la gracia y hasta HORAS_PARA_RECLAMAR después del
 * inicio—. Con ese reporte, la cancelación vuelve a ser tardía y la seña queda
 * para el dueño, que es lo que corresponde: tuvo el auto guardado y fue.
 *
 * Es exactamente lo que pide Turo: el dueño reporta el no-show dentro de un
 * plazo y recién entonces se le reconoce.
 *
 * ── Y SI EL DUEÑO MIENTE? LAS DOS CONSTANCIAS ────────────────────────────
 *
 * Queda un caso que lo de arriba no cubre: el dueño que va, NO entrega el auto,
 * y igual reporta que la persona no apareció. Con una sola constancia posible,
 * ese reporte no tenía contra qué contrastarse: era la única versión escrita
 * que existía, y se quedaba con la seña.
 *
 * Por eso ahora LAS DOS PARTES pueden dejar constancia, con la misma ventana y
 * las mismas reglas. Cuatro combinaciones, y TRES se resuelven solas:
 *
 *   · ninguno       → vuelve todo. El silencio no paga.
 *   · solo el dueño → se retiene la seña. Fue, esperó, lo asentó.
 *   · solo quien    → vuelve todo, y queda registrado que el dueño faltó. El
 *     alquiló         dinero es el mismo que si nadie hubiera hablado, pero
 *                     con un nombre al lado: sin eso, faltar y callarse se
 *                     parecen demasiado.
 *   · LOS DOS       → NO SE MUEVE NADA. La cancelación se traba, la plata
 *                     queda donde está, y el caso queda abierto con las dos
 *                     versiones y sus horas.
 *
 * POR QUÉ TRABARLA Y NO ELEGIR UNA. Porque el servidor no vio la vereda y
 * cualquier regla automática para este caso sería una moneda al aire con cara
 * de justicia. Lo que sí se puede hacer —y es lo que se hace— es que el caso
 * llegue ARMADO a quien lo tenga que resolver: las dos versiones, firmadas, con
 * hora, sobre una reserva con fechas e importes. Hoy eso lo mira una cuenta
 * administradora; mañana puede mirarlo una aseguradora o algo automático con
 * más datos de los que este archivo tiene. La forma no cambia.
 *
 * Y el efecto sobre el que quiera estafar es el que importa: mentir dejó de ser
 * gratis y silencioso. Antes alcanzaba con reportar para cobrar; ahora reportar
 * en falso traba la plata, deja la mentira firmada al lado de la otra versión,
 * y la decisión queda guardada —sin borrar la constancia que pierde—, así que
 * un dueño al que se le caen los reclamos una y otra vez se ve.
 *
 * ── POR QUÉ ESTÁ SOLO EN UN ARCHIVO ───────────────────────────────────────
 * Porque la decisión tiene que poder probarse con fechas elegidas a mano, sin
 * base de datos y sin reloj real (cancellation-policy.spec.ts). Una regla de
 * plazos escrita adentro de un servicio se prueba cambiándole la hora a la
 * máquina, o sea que no se prueba.
 */

/** Los estados en los que una reserva todavía se puede cancelar. */
export const cancellableStatuses: BookingStatus[] = [
  BookingStatus.REQUESTED,
  BookingStatus.ACCEPTED,
  BookingStatus.READY_FOR_PICKUP,
];

/**
 * Las horas antes del inicio hasta las que la cancelación es libre.
 *
 * Si esto cambia, cambia en los dos lados: el front muestra el mismo plazo en
 * la pantalla de la reserva (services/cancelacion.js). Que el aviso diga una
 * cosa y el servidor haga otra es peor que no avisar nada.
 */
export const HORAS_DE_GRACIA = 48;

/**
 * Cuántos minutos después del horario acordado se da por no aparecido.
 *
 * Media hora, igual que Turo. No es un número elegido por gusto: es el tiempo
 * que hay que dar para que un atraso normal —el tránsito, el colectivo, no
 * encontrar la esquina— no se trate como un plantón.
 */
export const MINUTOS_DE_GRACIA_EN_EL_RETIRO = 30;

/**
 * Hasta cuándo el dueño puede dejar constancia de que la persona no apareció.
 *
 * Una ventana y no "siempre", por dos motivos. Un reporte hecho tres días
 * después no lo puede discutir nadie, porque ya nadie se acuerda; y sobre todo,
 * sin plazo el dueño podría esperar a ver si le conviene y recién entonces
 * reclamar la seña. Veinticuatro horas desde el inicio es tiempo de sobra para
 * alguien que estuvo ahí esperando, y poco para pensarlo.
 */
export const HORAS_PARA_RECLAMAR_NO_SHOW = 24;

/** Quién tenía razón en un caso trabado. */
export type LadoDelNoShow = "OWNER" | "RENTER";

/**
 * Lee el lado guardado en la base, que es una columna de texto libre.
 *
 * Es texto y no un enum de la base a propósito: un enum nuevo en Postgres se
 * crea y se migra, y este valor lo escribe un solo lugar del servidor. Pero
 * "texto libre" significa que cualquier cosa puede llegar hasta acá, así que
 * entra por esta puerta: lo que no sea uno de los dos lados vale lo mismo que
 * no haber decidido nada, que es el lado seguro —el caso sigue trabado—.
 */
export function ladoDelNoShow(
  valor: string | null | undefined,
): LadoDelNoShow | null {
  return valor === "OWNER" || valor === "RENTER" ? valor : null;
}

export type CancellationTier =
  /** Con tiempo: vuelve todo. */
  | "libre"
  /** Sobre la fecha: se retiene la seña. */
  | "tardia"
  /** La canceló el dueño: vuelve todo, sin importar cuándo. */
  | "delDueno"
  /** Pasó la hora y nadie confirmó la entrega: vuelve todo. */
  | "nadieAparecio"
  /** Los dos dicen que el otro no fue: no se mueve nada hasta que se decida. */
  | "disputa"
  /** No se puede cancelar. */
  | "cerrada";

export interface CancellationDecision {
  puede: boolean;
  /** Código para el front cuando no se puede. */
  motivo: string | null;
  tier: CancellationTier;
  /** Si la seña NO se devuelve. */
  retieneSena: boolean;
  /** Cuántas horas faltan para el inicio (negativo si ya empezó). */
  horasParaElInicio: number;
}

const MS_POR_HORA = 60 * 60 * 1000;

/**
 * Qué corresponde hacer con esta cancelación.
 *
 * `ahora` entra por parámetro y no se lee adentro: una prueba de plazos que
 * dependa del reloj de la máquina pasa hoy y falla mañana.
 */
export function decidirCancelacion({
  status,
  startDate,
  ahora,
  laCancelaElDueno,
  entregaConfirmada = false,
  noAparecioElInquilino = false,
  noAparecioElDueno = false,
  resueltoAFavorDe = null,
}: {
  status: BookingStatus;
  startDate: Date;
  ahora: Date;
  laCancelaElDueno: boolean;
  /** Si alguien escaneó el código: entonces el auto se entregó de verdad. */
  entregaConfirmada?: boolean;
  /** Si el dueño dejó constancia de que la persona no apareció. */
  noAparecioElInquilino?: boolean;
  /** Si quien alquiló dejó constancia de que el dueño no apareció. */
  noAparecioElDueno?: boolean;
  /** Con las dos constancias: a favor de quién se decidió, si ya se decidió. */
  resueltoAFavorDe?: LadoDelNoShow | null;
}): CancellationDecision {
  const horasParaElInicio =
    (startDate.getTime() - ahora.getTime()) / MS_POR_HORA;

  /*
    LAS DOS CONSTANCIAS, Y LA DECISIÓN SI YA SE TOMÓ.

    Cuando los dos dicen que el otro no fue, el caso está trabado hasta que
    alguien lo resuelva. Una vez resuelto, la constancia que perdió deja de
    pesar —pero NO se borra: queda guardada, porque un reclamo que se cae una y
    otra vez es un dato sobre quien lo hizo—.
  */
  const hayDisputa =
    noAparecioElInquilino && noAparecioElDueno && !resueltoAFavorDe;
  // Tras la decisión, vale la versión de quien ganó y solo esa.
  const valeElReporteDelDueno = resueltoAFavorDe
    ? resueltoAFavorDe === "OWNER"
    : noAparecioElInquilino;
  const valeElReporteDelInquilino = resueltoAFavorDe
    ? resueltoAFavorDe === "RENTER"
    : noAparecioElDueno;

  if (!cancellableStatuses.includes(status)) {
    /*
      DOS MOTIVOS DISTINTOS, PORQUE SON DOS COSAS DISTINTAS.

      Una reserva EN CURSO no es una reserva cerrada: el auto está afuera y la
      salida existe, solo que no es cancelar — es devolverlo, que además libera
      las fechas que sobran. Decirle "no se puede cancelar" a secas manda a
      alguien a escribirle a soporte por algo que puede hacer solo.
    */
    const enCurso =
      status === BookingStatus.IN_PROGRESS ||
      status === BookingStatus.RETURN_PENDING;
    return {
      puede: false,
      motivo: enCurso ? "BOOKING_IN_PROGRESS" : "BOOKING_NOT_CANCELLABLE",
      tier: "cerrada",
      retieneSena: false,
      horasParaElInicio,
    };
  }

  /*
    CASO TRABADO: NO SE MUEVE NADA.

    Va ANTES que todo lo demás, incluida la cancelación del dueño. Si quedara
    después, al dueño acusado le alcanzaría con cancelar él para salir del
    trabado por la puerta de "cancela el dueño, vuelve todo" —que suena a favor
    de la otra parte, pero le serviría igual: cierra el caso y borra la
    discusión sobre la seña sin que nadie la mire—.

    La plata se queda exactamente donde está. Esto no es una negativa a
    devolver: es una pausa mientras el caso espera a quien lo resuelva.
  */
  if (hayDisputa) {
    return {
      puede: false,
      motivo: "NO_SHOW_DISPUTED",
      tier: "disputa",
      retieneSena: false,
      horasParaElInicio,
    };
  }

  // El dueño que se baja devuelve todo. No hay plazo que lo mejore: quien
  // deja a la otra persona sin auto no se queda además con su plata.
  if (laCancelaElDueno) {
    return {
      puede: true,
      motivo: null,
      tier: "delDueno",
      retieneSena: false,
      horasParaElInicio,
    };
  }

  if (horasParaElInicio >= HORAS_DE_GRACIA) {
    return {
      puede: true,
      motivo: null,
      tier: "libre",
      retieneSena: false,
      horasParaElInicio,
    };
  }

  /*
    NADIE APARECIÓ: VUELVE TODO.

    Pasó la hora acordada más la gracia y nadie confirmó la entrega. La seña
    paga tener el auto reservado y entregarlo; si no hay constancia de que se
    entregó, no hay nada que cobrar.

    Se mira `entregaConfirmada` y no el estado, porque son dos cosas distintas:
    el estado puede haber avanzado por otro camino, y lo que decide acá es si
    existe la constancia del escaneo.

    La excepción es el dueño que dejó su propia constancia de que la persona no
    fue. Ahí sí fue él el que cumplió, y la regla tardía vuelve a aplicar.

    Y al revés: la constancia de quien alquiló —"el dueño no vino"— entra por
    esta misma puerta aunque el reloj no la hubiera abierto todavía. En los
    hechos siempre la abre, porque reportar no se puede antes de la gracia;
    está escrito igual para que la regla se lea sola y no dependa de que el
    lector vaya a buscar la ventana a la otra función.
  */
  const graciaEnHoras = MINUTOS_DE_GRACIA_EN_EL_RETIRO / 60;
  if (
    !entregaConfirmada &&
    !valeElReporteDelDueno &&
    (valeElReporteDelInquilino || horasParaElInicio <= -graciaEnHoras)
  ) {
    return {
      puede: true,
      motivo: null,
      tier: "nadieAparecio",
      retieneSena: false,
      horasParaElInicio,
    };
  }

  return {
    puede: true,
    motivo: null,
    tier: "tardia",
    retieneSena: true,
    horasParaElInicio,
  };
}

/**
 * SI SE PUEDE DEJAR CONSTANCIA DE QUE EL OTRO NO APARECIÓ.
 *
 * LA MISMA REGLA PARA LOS DOS LADOS, y es deliberado: el dueño reporta que no
 * fue quien alquiló, quien alquiló reporta que no fue el dueño, y ninguno de
 * los dos tiene una ventana más cómoda que el otro. Una regla asimétrica acá
 * sería ponerle el pulgar a la balanza antes de que empiece la discusión.
 *
 * Tres condiciones, y cada una tapa una forma distinta de usarlo mal:
 *
 *  · La reserva tiene que seguir viva. Sobre una ya cancelada el reporte no
 *    cambia nada —la plata ya se repartió— y lo único que haría es ensuciar el
 *    registro con una acusación que llega cuando no hay nada que decidir.
 *  · No puede haber entrega confirmada. Si alguien escaneó el código, el auto
 *    se entregó y no hay nada que reportar.
 *  · Solo dentro de la ventana. Antes de la gracia sería reportar a alguien que
 *    todavía está llegando; pasada la ventana sería decidir con la billetera en
 *    la mano si conviene reclamar.
 */
export function puedeReportarNoShow({
  status,
  startDate,
  ahora,
  entregaConfirmada,
}: {
  /** Opcional por compatibilidad: sin dato no se bloquea por estado. */
  status?: BookingStatus;
  startDate: Date;
  ahora: Date;
  entregaConfirmada: boolean;
}): { puede: boolean; motivo: string | null } {
  /*
    La entrega se mira ANTES que el estado. Una reserva ya entregada tampoco
    está entre las cancelables, así que las dos condiciones darían false; pero
    no explican lo mismo. "El auto ya se entregó" dice qué pasó; "la reserva
    está cerrada" deja a alguien preguntándose por qué.
  */
  if (entregaConfirmada) {
    return { puede: false, motivo: "PICKUP_ALREADY_CONFIRMED" };
  }
  if (status !== undefined && !cancellableStatuses.includes(status)) {
    return { puede: false, motivo: "BOOKING_NOT_CANCELLABLE" };
  }
  const minutosDesdeElInicio =
    (ahora.getTime() - startDate.getTime()) / (60 * 1000);
  if (minutosDesdeElInicio < MINUTOS_DE_GRACIA_EN_EL_RETIRO) {
    return { puede: false, motivo: "TOO_EARLY_FOR_NO_SHOW" };
  }
  if (minutosDesdeElInicio > HORAS_PARA_RECLAMAR_NO_SHOW * 60) {
    return { puede: false, motivo: "NO_SHOW_WINDOW_CLOSED" };
  }
  return { puede: true, motivo: null };
}
