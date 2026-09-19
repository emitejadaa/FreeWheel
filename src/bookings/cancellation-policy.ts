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

export type CancellationTier =
  /** Con tiempo: vuelve todo. */
  | "libre"
  /** Sobre la fecha: se retiene la seña. */
  | "tardia"
  /** La canceló el dueño: vuelve todo, sin importar cuándo. */
  | "delDueno"
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
}: {
  status: BookingStatus;
  startDate: Date;
  ahora: Date;
  laCancelaElDueno: boolean;
}): CancellationDecision {
  const horasParaElInicio =
    (startDate.getTime() - ahora.getTime()) / MS_POR_HORA;

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

  return {
    puede: true,
    motivo: null,
    tier: "tardia",
    retieneSena: true,
    horasParaElInicio,
  };
}
