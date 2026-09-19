import { BookingStatus } from "@prisma/client";

/**
 * claim-window.ts — La ventana que el dueño tiene para revisar el auto
 * ---------------------------------------------------------------------------
 * ── EL PROBLEMA QUE ESTO RESUELVE ─────────────────────────────────────────
 * Hasta acá, al confirmarse la devolución el depósito en garantía se soltaba en
 * el mismo instante. Eso dejaba el reclamo por daños en una situación
 * imposible: cuando el dueño se acercaba al auto y veía el golpe, la retención
 * ya no existía y no había nada que capturar. O sea que el depósito servía para
 * todo menos para lo único que existe.
 *
 * Y adelantar el reclamo tampoco se puede: el auto vuelve y recién ahí se sabe
 * cómo vuelve. Quien confirma la devolución es quien alquiló, no el dueño, así
 * que en el momento del cambio de manos el dueño ni siquiera está en el
 * circuito.
 *
 * La única forma de que un reclamo llegue a tiempo es que el depósito siga
 * retenido un rato después de la devolución. Eso es esta ventana, y es
 * exactamente lo que hace cualquier alquiler de autos: la garantía no se libera
 * el mismo día que devolvés el auto.
 *
 * ── POR QUÉ 48 HORAS ──────────────────────────────────────────────────────
 * Es el plazo en el que alguien revisa un auto de verdad: el que lo recibe a la
 * noche lo mira a la mañana siguiente. Más corto deja afuera una devolución de
 * viernes a la tarde; más largo convierte la garantía de todo el mundo en plata
 * bloqueada por si acaso, para un caso que casi nunca pasa.
 *
 * ── LO QUE NO HAY, Y HAY QUE SABERLO ──────────────────────────────────────
 * Este backend no tiene un programador de tareas, así que NADIE se despierta a
 * las 48 horas a soltar la retención. Se suelta cuando pasa algo:
 *
 *   · el dueño dice "está todo bien" (el camino normal, y el que el mail le
 *     pide),
 *   · un administrador rechaza el reclamo,
 *   · alguien abre el estado del pago de esa reserva y la ventana ya venció.
 *
 * Y si no pasa ninguna de las tres, la retención se cae sola: una autorización
 * sin capturar expira en Stripe a los 7 días y el banco devuelve el límite.
 * O sea que la plata nunca queda trabada para siempre; lo peor que pasa es que
 * tarda unos días más de lo que dice el mail.
 *
 * Eso también pone el techo del reclamo: un administrador tiene esos 7 días
 * para resolverlo. Después no hay retención que capturar.
 */

/** Las horas que el dueño tiene para revisar el auto y reclamar. */
export const HORAS_DE_REVISION = 48;

/** Los días que Stripe mantiene viva una autorización sin capturar. */
export const DIAS_HASTA_QUE_EXPIRA = 7;

const MS_POR_HORA = 60 * 60 * 1000;

export interface EstadoDeLaRevision {
  /** Si el dueño todavía puede abrir un reclamo. */
  abierta: boolean;
  /** Si corresponde soltar el depósito ya. */
  sePuedeLiberar: boolean;
  /** Cuándo vence la ventana, o null si la reserva no llegó a devolverse. */
  vence: Date | null;
  /** Horas que quedan (negativas si ya venció). */
  horasQueQuedan: number;
}

/**
 * En qué anda la ventana de revisión de esta reserva.
 *
 * `ahora` entra por parámetro: una prueba de plazos atada al reloj de la
 * máquina pasa hoy y falla mañana.
 *
 * @param booking.status            en qué anda la reserva
 * @param booking.returnConfirmedAt cuándo se confirmó la devolución
 * @param hayReclamoAbierto         si el dueño ya reclamó y está sin resolver
 */
export function estadoDeLaRevision({
  status,
  returnConfirmedAt,
  hayReclamoAbierto = false,
  ahora,
}: {
  status: BookingStatus;
  returnConfirmedAt: Date | null;
  hayReclamoAbierto?: boolean;
  ahora: Date;
}): EstadoDeLaRevision {
  // Sin devolución confirmada no hay ventana: el auto todavía está afuera y el
  // depósito tiene que seguir retenido por el motivo de siempre.
  if (status !== BookingStatus.COMPLETED || !returnConfirmedAt) {
    return {
      abierta: false,
      sePuedeLiberar: false,
      vence: null,
      horasQueQuedan: 0,
    };
  }

  const vence = new Date(
    returnConfirmedAt.getTime() + HORAS_DE_REVISION * MS_POR_HORA,
  );
  const horasQueQuedan = (vence.getTime() - ahora.getTime()) / MS_POR_HORA;

  /*
    UN RECLAMO ABIERTO CONGELA TODO.

    Mientras un administrador no lo resuelva, el depósito no se suelta aunque
    la ventana haya vencido hace tres días: soltarlo sería resolver el reclamo
    a favor de una de las partes por el solo paso del tiempo, y encima sin
    decirlo. La ventana es para ABRIR el reclamo, no para resolverlo.
  */
  if (hayReclamoAbierto) {
    return { abierta: false, sePuedeLiberar: false, vence, horasQueQuedan };
  }

  const vencida = horasQueQuedan <= 0;
  return {
    abierta: !vencida,
    sePuedeLiberar: vencida,
    vence,
    horasQueQuedan,
  };
}
