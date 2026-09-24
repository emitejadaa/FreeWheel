/**
 * EL TICKET: QUÉ SE PAGA Y A DÓNDE VA CADA PESO.
 *
 * El pago es UNO SOLO, pero la persona tiene que poder ver, antes de pagar y
 * en el comprobante, de qué está hecho. Se muestra de dos maneras que suman lo
 * mismo:
 *
 *   · `lines`        — lo que paga el inquilino: la seña, el resto del
 *                      alquiler y la cobertura.
 *   · `distribution` — a quién le corresponde: al dueño, a FreeWheel (su
 *                      comisión) y a la aseguradora.
 *
 * Que las dos vistas sumen exactamente el total no es un detalle: es lo que
 * permite que cualquiera —el inquilino, el dueño, un contador, un juez—
 * reconstruya el cobro sin tener que creerle a nadie. Por eso todo va en
 * centavos enteros y la última línea de cada vista se calcula por diferencia:
 * con decimales, dos redondeos pueden hacer que las partes no sumen el todo.
 *
 * El depósito en garantía va APARTE y no suma: es una retención en la tarjeta,
 * no un pago. Mezclarlo con el total haría creer que se cobró.
 */

export interface TicketSnapshots {
  currency: string;
  days: number;
  pricePerDay: number;
  /** Los montos tal como los guarda la reserva, en unidades (no centavos). */
  rentalSubtotal: number | null;
  insurance: number | null;
  commission: number | null;
  sena: number | null;
  deposit: number | null;
}

export interface TicketLine {
  code: "SENA" | "RENTAL_REST" | "INSURANCE";
  label: string;
  amountMinor: number;
}

export interface DistributionLine {
  code: "OWNER" | "PLATFORM_COMMISSION" | "INSURER";
  label: string;
  amountMinor: number;
}

export interface Ticket {
  currency: string;
  days: number;
  pricePerDayMinor: number;
  lines: TicketLine[];
  distribution: DistributionLine[];
  totalMinor: number;
  sena: {
    amountMinor: number;
    /** Qué porción del alquiler es seña, en porcentaje entero. */
    percentOfRental: number;
    kind: "PENITENCIAL";
    rule: string;
  };
  deposit: {
    amountMinor: number;
    kind: "HOLD";
    note: string;
  };
  /**
   * Cómo se mueve la plata con el procesador. Va en el ticket porque cambia
   * lo que cada uno recibe: Mercado Pago cobra su comisión de la parte del
   * dueño, y ese monto no se conoce antes de pagar (depende del plazo de
   * liberación que el dueño eligió en su cuenta).
   */
  processor: {
    name: "mercadopago";
    note: string;
  };
}

const aMinor = (valor: number | null | undefined): number =>
  Math.round((valor ?? 0) * 100);

export function buildTicket(s: TicketSnapshots): Ticket {
  const rental = aMinor(s.rentalSubtotal);
  const insurance = aMinor(s.insurance);
  const commission = aMinor(s.commission);
  // La seña nunca puede ser más que el alquiler: si una reserva vieja la
  // tiene calculada sobre el total, se acota.
  const sena = Math.min(aMinor(s.sena), rental);
  const total = rental + insurance;

  return {
    currency: s.currency,
    days: s.days,
    pricePerDayMinor: aMinor(s.pricePerDay),
    lines: [
      { code: "SENA", label: "Seña (parte del alquiler)", amountMinor: sena },
      {
        code: "RENTAL_REST",
        label: "Resto del alquiler",
        amountMinor: rental - sena,
      },
      { code: "INSURANCE", label: "Cobertura", amountMinor: insurance },
    ],
    distribution: [
      {
        code: "OWNER",
        label: "Para el dueño del auto (en su cuenta de Mercado Pago)",
        amountMinor: rental - commission,
      },
      {
        code: "PLATFORM_COMMISSION",
        label: "Comisión de FreeWheel",
        amountMinor: commission,
      },
      {
        code: "INSURER",
        label:
          "Para la cobertura (la cobra FreeWheel por cuenta de la aseguradora)",
        amountMinor: total - (rental - commission) - commission,
      },
    ],
    totalMinor: total,
    sena: {
      amountMinor: sena,
      percentOfRental: rental > 0 ? Math.round((sena / rental) * 100) : 0,
      kind: "PENITENCIAL",
      rule:
        "Si quien alquila se arrepiente fuera del plazo de arrepentimiento, " +
        "pierde la seña a favor del dueño. Si el dueño se arrepiente, devuelve " +
        "la seña doblada (Código Civil y Comercial, art. 1059).",
    },
    deposit: {
      amountMinor: aMinor(s.deposit),
      kind: "HOLD",
      note:
        "No es un cobro: es una reserva de fondos en tu tarjeta, que se " +
        "autoriza cerca del retiro y se libera si el auto vuelve sin daños " +
        "reportados dentro de la ventana de inspección.",
    },
    processor: {
      name: "mercadopago",
      note:
        "El pago se hace con Mercado Pago y se acredita directo en la cuenta " +
        "del dueño. Mercado Pago descuenta su comisión de la parte del dueño, " +
        "según el plazo de liberación que el dueño tenga configurado.",
    },
  };
}
