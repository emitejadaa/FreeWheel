import { computeCancellation, CancellationInput } from "./cancellation-policy";

/**
 * Cada caso es una situación que va a pasar de verdad, y cada uno tiene una
 * persona que va a mirar su resumen de tarjeta preguntándose por qué le
 * devolvieron lo que le devolvieron.
 *
 * Reserva de referencia: alquiler 3000, cobertura 300 (total 3300), seña 900
 * (30 % del alquiler), comisión 10 %.
 */
const DIA = 24 * 60 * 60 * 1000;
const PAGO = new Date("2026-09-01T12:00:00.000Z");

const base: CancellationInput = {
  cancelledBy: "RENTER",
  paidMinor: 330000,
  rentalMinor: 300000,
  insuranceMinor: 30000,
  senaMinor: 90000,
  commissionPct: 0.1,
  paidAt: PAGO,
  pickupConfirmed: false,
  now: new Date(PAGO.getTime() + 3 * DIA),
  withdrawalDays: 10,
  // Sobre la fecha, que es el caso en el que la plata se reparte distinto. El
  // tramo lo decide bookings/cancellation-policy.ts mirando las horas que
  // faltan; acá entra ya decidido.
  tier: "tardia",
};

describe("computeCancellation", () => {
  it("sin pago no hay nada que repartir", () => {
    const r = computeCancellation({ ...base, paidAt: null, paidMinor: 0 });
    expect(r.rule).toBe("UNPAID");
    expect(r.refundToRenterMinor).toBe(0);
  });

  it("dentro del plazo de arrepentimiento, quien alquila recupera todo", () => {
    const r = computeCancellation(base);
    expect(r.rule).toBe("CONSUMER_WITHDRAWAL");
    expect(r.refundToRenterMinor).toBe(330000);
    expect(r.ownerReceivesMinor).toBe(0);
    expect(r.platformReceivesMinor).toBe(0);
  });

  it("el día 10 todavía es arrepentimiento", () => {
    const r = computeCancellation({
      ...base,
      now: new Date(PAGO.getTime() + 10 * DIA),
    });
    expect(r.rule).toBe("CONSUMER_WITHDRAWAL");
  });

  it("con más de 48 horas de anticipación vuelve todo, aunque el plazo de arrepentimiento haya pasado", () => {
    // Es la política comercial, no la ley: el dueño todavía tiene tiempo real
    // de volver a alquilar esas fechas. Es la que el front muestra.
    const r = computeCancellation({
      ...base,
      tier: "libre",
      now: new Date(PAGO.getTime() + 11 * DIA),
    });
    expect(r.rule).toBe("FREE_CANCELLATION");
    expect(r.refundToRenterMinor).toBe(330000);
    expect(r.ownerReceivesMinor).toBe(0);
  });

  it("el arrepentimiento gana sobre el tramo tardío", () => {
    // Una política comercial no puede sacar un derecho de orden público: si
    // pagó hace tres días, recupera todo aunque cancele sobre la fecha.
    const r = computeCancellation({ ...base, tier: "tardia" });
    expect(r.rule).toBe("CONSUMER_WITHDRAWAL");
    expect(r.refundToRenterMinor).toBe(330000);
  });

  it("fuera del plazo, pierde la seña y recupera el resto y la cobertura", () => {
    const r = computeCancellation({
      ...base,
      now: new Date(PAGO.getTime() + 11 * DIA),
    });
    expect(r.rule).toBe("RENTER_FORFEITS_SENA");
    expect(r.refundToRenterMinor).toBe(240000); // 3300 - 900
    // La comisión se cobra sobre lo que el dueño efectivamente gana.
    expect(r.platformReceivesMinor).toBe(9000);
    expect(r.ownerReceivesMinor).toBe(81000);
    // Todo lo pagado va a algún lado, sin sobrante ni faltante.
    expect(
      r.refundToRenterMinor + r.ownerReceivesMinor + r.platformReceivesMinor,
    ).toBe(330000);
  });

  it("si cancela el dueño, se devuelve todo y el dueño debe otra seña", () => {
    const r = computeCancellation({
      ...base,
      cancelledBy: "OWNER",
      now: new Date(PAGO.getTime() + 20 * DIA),
    });
    expect(r.rule).toBe("OWNER_RETURNS_SENA_DOUBLED");
    expect(r.refundToRenterMinor).toBe(330000);
    expect(r.ownerPenaltyMinor).toBe(90000);
  });

  it("si cancela la plataforma, se devuelve todo y nadie paga penalidad", () => {
    const r = computeCancellation({ ...base, cancelledBy: "PLATFORM" });
    expect(r.rule).toBe("PLATFORM_CANCELLED");
    expect(r.refundToRenterMinor).toBe(330000);
    expect(r.ownerPenaltyMinor).toBe(0);
  });

  it("la seña nunca supera lo efectivamente pagado", () => {
    // Una reserva vieja que llegó a pagar solo una parte.
    const r = computeCancellation({
      ...base,
      paidMinor: 50000,
      now: new Date(PAGO.getTime() + 30 * DIA),
    });
    expect(r.refundToRenterMinor).toBe(0);
    expect(r.ownerReceivesMinor + r.platformReceivesMinor).toBe(50000);
  });

  it("con el auto ya retirado no se cancela: es un reclamo", () => {
    expect(() =>
      computeCancellation({ ...base, pickupConfirmed: true }),
    ).toThrow();
  });
});
