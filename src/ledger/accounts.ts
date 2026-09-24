/**
 * LOS NOMBRES DE LAS CUENTAS DEL LIBRO.
 *
 * Una cuenta es un "bolsillo" donde se acumula plata con un dueño y un motivo.
 * Se nombran con un texto jerárquico en vez de una tabla de cuentas porque así
 * se pueden sumar por prefijo: todo lo de una reserva ("booking:<id>:"), todo
 * lo que se le debe a los dueños ("owner:"), todo lo que es de la aseguradora.
 *
 * Nadie arma estos textos a mano: si cada módulo los escribiera como le
 * parece, un typo abriría una cuenta nueva en silencio y la plata quedaría en
 * un bolsillo que nadie mira.
 */
export const Accounts = {
  /** La seña de ESA reserva, retenida hasta que se sepa de quién es. */
  bookingSena: (bookingId: string) => `booking:${bookingId}:sena`,
  /** El resto del alquiler de esa reserva, retenido. */
  bookingRental: (bookingId: string) => `booking:${bookingId}:rental`,
  /** La cobertura cobrada en esa reserva, retenida. */
  bookingInsurance: (bookingId: string) => `booking:${bookingId}:insurance`,
  /** Lo que se le debe a un dueño (positivo) o lo que él debe (negativo). */
  ownerPayable: (ownerId: string) => `owner:${ownerId}:payable`,
  /** Lo que se le debe a quien alquiló por fuera de un reembolso a tarjeta. */
  renterPayable: (renterId: string) => `renter:${renterId}:payable`,
  /** Lo que ganó FreeWheel. Es la única cuenta que es de FreeWheel. */
  platformCommission: () => "platform:commission",
  /**
   * Primas cobradas por cuenta de la aseguradora. NO es plata de FreeWheel:
   * es una deuda con un tercero, y se salda pagándosela. Tratarla como un
   * fondo propio del que se saca el sobrante sería operar como aseguradora sin
   * autorización (Ley 20.091).
   */
  insurancePayable: () => "insurance:payable",
  /** La plata que entra y sale por el procesador de pagos. */
  processorClearing: () => "processor:clearing",
  /**
   * CUENTAS DE ORDEN DEL SPLIT DE PAGOS.
   *
   * Con Mercado Pago, la parte del dueño entra DIRECTO a su cuenta: nunca
   * pasa por FreeWheel, así que no es plata de FreeWheel y no puede estar en
   * sus bolsillos. Pero la reserva tiene que poder explicarse entera —cuánto
   * se cobró y a dónde fue cada peso—, y para eso están estas dos: anotan lo
   * que el dueño recibió por fuera, sin mezclarlo con lo propio.
   *
   * Sumadas dan cero siempre. No representan un saldo a cobrar ni a pagar.
   */
  splitOwnerDirect: (ownerId: string) => `split:owner:${ownerId}:direct`,
  splitCollected: () => "split:collected",
} as const;

/** El dueño de una cuenta, si es de una persona. */
export function accountUserId(account: string): string | null {
  const match = /^(owner|renter):([^:]+):/.exec(account);
  return match ? match[2] : null;
}
