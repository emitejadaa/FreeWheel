/**
 * QUIÉN SE QUEDA CON QUÉ CUANDO SE CANCELA UNA RESERVA PAGA.
 *
 * Es una función pura a propósito: la regla que decide plata de dos personas
 * tiene que poder leerse entera en un lugar y probarse caso por caso, sin base
 * de datos ni procesador de pagos en el medio.
 *
 * ── CUÁNDO se puede cancelar lo decide OTRO archivo ─────────────────────────
 * `bookings/cancellation-policy.ts` mira el estado y los plazos y contesta si
 * se puede y en qué tramo cae (libre / tardía / del dueño). Acá entra ese
 * tramo ya decidido, y se resuelve la PLATA.
 *
 * Están separados porque son dos preguntas distintas -"¿puedo cancelar?" y
 * "¿cuánto vuelve?"- y porque el front ya muestra el plazo de las 48 horas que
 * decide la primera. Si cada archivo calculara las horas por su cuenta, un día
 * la pantalla diría una cosa y el cobro haría otra.
 *
 * ── Las reglas ──────────────────────────────────────────────────────────────
 *
 * 1. ARREPENTIMIENTO DEL CONSUMIDOR. Quien alquila puede revocar dentro de los
 *    10 días corridos desde que pagó, y antes de retirar el auto, sin perder
 *    nada (Ley 24.240 art. 34 y CCyC art. 1110; el alquiler de autos no está
 *    entre las excepciones del art. 1116). Es de orden público: ninguna
 *    cláusula lo puede sacar, así que la seña no puede comerse este derecho.
 *    El plazo es configurable (CONSUMER_WITHDRAWAL_DAYS) porque hay que
 *    confirmarlo con un abogado para servicios con fecha; el valor por
 *    omisión es el que protege al consumidor.
 *
 *    GANA SIEMPRE QUE APLIQUE, incluso sobre el tramo "tardía": una política
 *    comercial no puede sacar un derecho de orden público. En la práctica eso
 *    quiere decir que alguien que pagó hace tres días y cancela la noche
 *    anterior recupera todo, aunque el tramo diga que pierde la seña. Está
 *    anotado en CONSULTAS-LEGALES.md para confirmarlo: es la pregunta de si el
 *    plazo corre desde el pago o desde la contratación de un servicio con
 *    fecha.
 *
 * 2. CANCELACIÓN LIBRE (tramo "libre"). Con 48 horas o más de anticipación
 *    vuelve todo. No lo pide ninguna ley: es la política comercial, y es la
 *    que el front muestra en la pantalla de la reserva.
 *
 * 3. SEÑA PENITENCIAL (CCyC art. 1059). Sobre la fecha (tramo "tardía") y
 *    fuera del plazo de arrepentimiento:
 *    · si se arrepiente quien alquila, pierde la seña a favor del dueño. El
 *      resto del alquiler y la cobertura se le devuelven: la cobertura no
 *      cubrió nada, y el resto del alquiler es por un servicio que no se
 *      prestó. FreeWheel cobra su comisión solo sobre lo que el dueño
 *      efectivamente gana, que es la seña.
 *    · si se arrepiente el dueño, devuelve la seña DOBLADA: quien alquila
 *      recupera todo lo que pagó y además el dueño le debe otro tanto como la
 *      seña. Esa segunda parte no se puede devolver a la tarjeta —un reembolso
 *      no puede superar el cobro original— así que queda registrada como deuda
 *      del dueño (se descuenta de sus próximos cobros) y crédito de quien
 *      alquiló (se le paga por otra vía).
 *
 * 3. CANCELA LA PLATAFORMA (fraude, seguridad, un auto que no era de quien lo
 *    publicaba): se devuelve todo y nadie paga penalidad.
 *
 * Después del retiro del auto no se cancela: el servicio ya empezó, y lo que
 * pase de ahí en más es un reclamo, no una cancelación.
 */

export type CancelledBy = "RENTER" | "OWNER" | "PLATFORM";

export type CancellationRule =
  | "UNPAID"
  | "CONSUMER_WITHDRAWAL"
  | "FREE_CANCELLATION"
  | "RENTER_FORFEITS_SENA"
  | "OWNER_RETURNS_SENA_DOUBLED"
  | "PLATFORM_CANCELLED";

export interface CancellationInput {
  cancelledBy: CancelledBy;
  /**
   * El tramo que decidió `bookings/cancellation-policy.ts`. "libre" es con
   * tiempo, "tardia" es sobre la fecha. Acá no se vuelven a mirar las horas.
   */
  tier: "libre" | "tardia";
  /** Lo efectivamente cobrado y todavía no devuelto, en centavos. */
  paidMinor: number;
  rentalMinor: number;
  insuranceMinor: number;
  senaMinor: number;
  /** Comisión de la plataforma como fracción (0.10 = 10 %). */
  commissionPct: number;
  /** Cuándo se cobró. Sin cobro no hay nada que repartir. */
  paidAt: Date | null;
  pickupConfirmed: boolean;
  now: Date;
  /** Días corridos del derecho de arrepentimiento. */
  withdrawalDays: number;
}

export interface CancellationOutcome {
  rule: CancellationRule;
  /** Lo que se le devuelve a la tarjeta de quien alquiló. */
  refundToRenterMinor: number;
  /** Lo que gana el dueño, ya descontada la comisión. */
  ownerReceivesMinor: number;
  /** La comisión de FreeWheel sobre lo que ganó el dueño. */
  platformReceivesMinor: number;
  /**
   * Lo que el dueño le debe a quien alquiló además del reembolso (la mitad de
   * "la seña doblada"). Se registra como deuda; no pasa por la tarjeta.
   */
  ownerPenaltyMinor: number;
  explanation: string;
}

const DIA_MS = 24 * 60 * 60 * 1000;

export function computeCancellation(
  input: CancellationInput,
): CancellationOutcome {
  if (input.pickupConfirmed) {
    throw new Error(
      "Una reserva con el auto ya retirado no se cancela: es un reclamo.",
    );
  }

  const paid = Math.max(0, Math.trunc(input.paidMinor));
  if (!input.paidAt || paid === 0) {
    return {
      rule: "UNPAID",
      refundToRenterMinor: 0,
      ownerReceivesMinor: 0,
      platformReceivesMinor: 0,
      ownerPenaltyMinor: 0,
      explanation: "La reserva no estaba paga: no hay nada que devolver.",
    };
  }

  const todo = {
    refundToRenterMinor: paid,
    ownerReceivesMinor: 0,
    platformReceivesMinor: 0,
  };

  if (input.cancelledBy === "PLATFORM") {
    return {
      rule: "PLATFORM_CANCELLED",
      ...todo,
      ownerPenaltyMinor: 0,
      explanation:
        "La plataforma canceló la reserva: se devuelve todo lo pagado.",
    };
  }

  // La seña nunca puede ser más que lo que efectivamente se pagó (una
  // reserva vieja pudo haber pagado solo una parte).
  const sena = Math.min(Math.max(0, input.senaMinor), paid);

  if (input.cancelledBy === "OWNER") {
    return {
      rule: "OWNER_RETURNS_SENA_DOUBLED",
      ...todo,
      ownerPenaltyMinor: sena,
      explanation:
        "El dueño se arrepintió: se devuelve todo lo pagado y el dueño debe " +
        "además un monto igual a la seña (seña devuelta doblada, CCyC art. 1059).",
    };
  }

  const diasDesdeElPago =
    (input.now.getTime() - input.paidAt.getTime()) / DIA_MS;
  if (diasDesdeElPago <= input.withdrawalDays) {
    return {
      rule: "CONSUMER_WITHDRAWAL",
      ...todo,
      ownerPenaltyMinor: 0,
      explanation:
        `Cancelaste dentro de los ${input.withdrawalDays} días del pago y antes ` +
        "de retirar el auto: se ejerce el derecho de arrepentimiento y se " +
        "devuelve todo lo pagado.",
    };
  }

  if (input.tier === "libre") {
    return {
      rule: "FREE_CANCELLATION",
      ...todo,
      ownerPenaltyMinor: 0,
      explanation:
        "Cancelaste con más de 48 horas de anticipación: se devuelve todo lo " +
        "pagado. El dueño todavía tiene tiempo de volver a alquilar esas fechas.",
    };
  }

  const comision = Math.round(sena * input.commissionPct);
  return {
    rule: "RENTER_FORFEITS_SENA",
    refundToRenterMinor: paid - sena,
    ownerReceivesMinor: sena - comision,
    platformReceivesMinor: comision,
    ownerPenaltyMinor: 0,
    explanation:
      "Cancelaste fuera del plazo de arrepentimiento: la seña queda para el " +
      "dueño (CCyC art. 1059) y se devuelve el resto del alquiler y la cobertura.",
  };
}
