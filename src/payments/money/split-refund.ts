/**
 * CÓMO QUEDA LA PLATA DESPUÉS DE UNA DEVOLUCIÓN EN UN SPLIT DE PAGOS.
 *
 * ── El problema ─────────────────────────────────────────────────────────────
 * En el split de Mercado Pago, cada cobro se reparte en el momento: el dueño
 * recibe el total menos la comisión de la aplicación, y FreeWheel recibe esa
 * comisión (que acá es comisión + cobertura). Cuando se devuelve plata,
 * Mercado Pago la descuenta EN PROPORCIÓN de las dos cuentas. No se puede
 * elegir de quién sale.
 *
 * Eso coincide con la política de cancelación cuando se devuelve todo, pero
 * no en el caso de la seña. Ejemplo, con alquiler 3000, cobertura 300,
 * comisión 300 y seña 900:
 *
 *   · la política dice: quien cancela tarde pierde la seña; el dueño se queda
 *     con 810 (la seña menos la comisión) y FreeWheel con 90. La cobertura se
 *     devuelve entera: no cubrió nada.
 *   · Mercado Pago, al devolver 2400, le saca a FreeWheel 436,36 y al dueño
 *     1963,64. FreeWheel termina con 163,64 y el dueño con 736,36.
 *
 * FreeWheel quedó con 73,64 que son del dueño. No se puede transferir por
 * Mercado Pago (el split no tiene transferencias), así que queda ANOTADO como
 * deuda con el dueño en su bolsillo (owner:<id>:payable), y se paga por
 * fuera. Es la única forma de que los libros digan la verdad.
 *
 * ── Qué devuelve ────────────────────────────────────────────────────────────
 * Las líneas del asiento, listas para el libro. Suman cero siempre (FreeWheel
 * devuelve su parte proporcional, reconoce la comisión que le corresponde,
 * saca la cobertura y el resto queda con el dueño), más las dos de orden que
 * registran lo que el dueño devolvió de su propia cuenta.
 */

export interface SplitRefundInput {
  /** Lo cobrado en el pago (alquiler + cobertura). */
  totalMinor: number;
  /** La comisión que se le había anotado a FreeWheel en ese pago. */
  commissionMinor: number;
  /** La cobertura que se había anotado como deuda con la aseguradora. */
  insuranceMinor: number;
  /** Lo que se le devuelve a quien alquiló. */
  refundMinor: number;
  /** La comisión que la política dice que le corresponde a FreeWheel. */
  expectedCommissionMinor: number;
}

export interface SplitRefundOutcome {
  /** Lo que Mercado Pago le descuenta a FreeWheel. */
  platformRefundedMinor: number;
  /** Lo que Mercado Pago le descuenta al dueño. */
  ownerRefundedMinor: number;
  /**
   * Lo que FreeWheel le debe al dueño (positivo) o el dueño a FreeWheel
   * (negativo) para que el reparto final sea el de la política.
   */
  ownerAdjustmentMinor: number;
}

export function reconcileSplitRefund(
  input: SplitRefundInput,
): SplitRefundOutcome {
  const total = Math.max(0, Math.trunc(input.totalMinor));
  const comision = Math.max(0, Math.trunc(input.commissionMinor));
  const cobertura = Math.max(0, Math.trunc(input.insuranceMinor));
  const fee = comision + cobertura;
  const devuelto = Math.min(Math.max(0, Math.trunc(input.refundMinor)), total);

  // Mercado Pago no informa cuánto le descontó a cada cuenta en una
  // devolución: se calcula acá con la misma proporción. Por redondeo puede
  // diferir en un centavo de lo que aplicó Mercado Pago; la conciliación
  // mensual contra el resumen de la cuenta es lo que lo corrige.
  const platformRefunded =
    total === 0 || devuelto === 0
      ? 0
      : devuelto === total
        ? fee
        : Math.round((fee * devuelto) / total);
  const ownerRefunded = devuelto - platformRefunded;
  const retenidoPorFreeWheel = fee - platformRefunded;

  return {
    platformRefundedMinor: platformRefunded,
    ownerRefundedMinor: ownerRefunded,
    ownerAdjustmentMinor:
      retenidoPorFreeWheel -
      Math.max(0, Math.trunc(input.expectedCommissionMinor)),
  };
}
