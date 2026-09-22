import { buildTicket } from "./ticket";

describe("buildTicket", () => {
  const ticket = buildTicket({
    currency: "usd",
    days: 3,
    pricePerDay: 1000,
    rentalSubtotal: 3000,
    insurance: 300,
    commission: 300,
    sena: 900,
    deposit: 200,
  });

  it("lo que paga el inquilino suma exactamente el total", () => {
    const suma = ticket.lines.reduce((t, l) => t + l.amountMinor, 0);
    expect(suma).toBe(ticket.totalMinor);
    expect(ticket.totalMinor).toBe(330000);
  });

  it("a dónde va cada peso también suma exactamente el total", () => {
    const suma = ticket.distribution.reduce((t, l) => t + l.amountMinor, 0);
    expect(suma).toBe(ticket.totalMinor);
    const por = Object.fromEntries(
      ticket.distribution.map((l) => [l.code, l.amountMinor]),
    );
    expect(por.OWNER).toBe(270000);
    expect(por.PLATFORM_COMMISSION).toBe(30000);
    expect(por.INSURER).toBe(30000);
  });

  it("la seña es penitencial y parte del alquiler", () => {
    expect(ticket.sena.amountMinor).toBe(90000);
    expect(ticket.sena.percentOfRental).toBe(30);
    expect(ticket.sena.kind).toBe("PENITENCIAL");
  });

  it("el depósito va aparte y no suma al total", () => {
    expect(ticket.deposit.amountMinor).toBe(20000);
    expect(ticket.deposit.kind).toBe("HOLD");
  });

  it("una seña vieja calculada sobre el total se acota al alquiler", () => {
    const t = buildTicket({
      currency: "usd",
      days: 1,
      pricePerDay: 100,
      rentalSubtotal: 100,
      insurance: 10,
      commission: 10,
      sena: 500,
      deposit: 0,
    });
    expect(t.sena.amountMinor).toBe(10000);
    expect(t.lines.find((l) => l.code === "RENTAL_REST")?.amountMinor).toBe(0);
  });
});
