import { PricingService } from "./pricing.service";

function makeService(overrides: Record<string, string> = {}): PricingService {
  const env: Record<string, string> = {
    PLATFORM_FEE_PCT: "0.10",
    INSURANCE_PCT: "0.10",
    SENA_PCT: "0.30",
    DEPOSIT_DEFAULT_USD: "200",
    DEFAULT_CURRENCY: "usd",
    ...overrides,
  };
  const config = { get: (key: string) => env[key] };
  return new PricingService(config as never);
}

describe("PricingService", () => {
  it("computes the full money breakdown for a simple booking", () => {
    const pricing = makeService().computeBooking({
      pricePerDay: 100,
      days: 3,
    });

    expect(pricing.currency).toBe("usd");
    expect(pricing.days).toBe(3);
    expect(pricing.rentalSubtotal).toBe(300);
    expect(pricing.insurance).toBe(30);
    expect(pricing.commission).toBe(30);
    expect(pricing.total).toBe(330);
    // La seña es el 30% del ALQUILER (300), no del total con la cobertura.
    expect(pricing.sena).toBe(90);
    expect(pricing.balance).toBe(240);
    expect(pricing.ownerPayout).toBe(270);
    expect(pricing.deposit).toBe(200);
  });

  it("exposes integer minor units consistent with the decimal amounts", () => {
    const pricing = makeService().computeBooking({
      pricePerDay: 100,
      days: 3,
    });

    expect(pricing.rentalSubtotalMinor).toBe(30000);
    expect(pricing.insuranceMinor).toBe(3000);
    expect(pricing.commissionMinor).toBe(3000);
    expect(pricing.totalMinor).toBe(33000);
    expect(pricing.senaMinor).toBe(9000);
    expect(pricing.balanceMinor).toBe(24000);
    expect(pricing.ownerPayoutMinor).toBe(27000);
    expect(pricing.depositMinor).toBe(20000);
    // sena + balance must reconstruct the total exactly, with no float drift.
    expect(pricing.senaMinor + pricing.balanceMinor).toBe(pricing.totalMinor);
  });

  it("rounds to whole minor units without drift on fractional prices", () => {
    const pricing = makeService().computeBooking({
      pricePerDay: 33.33,
      days: 1,
    });

    // every minor amount is an integer
    for (const v of [
      pricing.rentalSubtotalMinor,
      pricing.insuranceMinor,
      pricing.commissionMinor,
      pricing.totalMinor,
      pricing.senaMinor,
      pricing.balanceMinor,
      pricing.ownerPayoutMinor,
    ]) {
      expect(Number.isInteger(v)).toBe(true);
    }
    expect(pricing.rentalSubtotalMinor).toBe(3333);
    expect(pricing.totalMinor).toBe(
      pricing.rentalSubtotalMinor + pricing.insuranceMinor,
    );
    expect(pricing.senaMinor + pricing.balanceMinor).toBe(pricing.totalMinor);
    expect(pricing.ownerPayoutMinor).toBe(
      pricing.rentalSubtotalMinor - pricing.commissionMinor,
    );
  });

  it("respects configured percentages", () => {
    const pricing = makeService({
      PLATFORM_FEE_PCT: "0.15",
      INSURANCE_PCT: "0.05",
      SENA_PCT: "0.50",
    }).computeBooking({ pricePerDay: 200, days: 2 });

    expect(pricing.rentalSubtotal).toBe(400);
    expect(pricing.commission).toBe(60); // 15%
    expect(pricing.insurance).toBe(20); // 5%
    expect(pricing.total).toBe(420);
    expect(pricing.sena).toBe(200); // 50% del alquiler (400)
    expect(pricing.balance).toBe(220);
    expect(pricing.ownerPayout).toBe(340); // 400 - 60
  });

  it("falls back to sane defaults when config is missing", () => {
    const config = { get: () => undefined };
    const pricing = new PricingService(config as never).computeBooking({
      pricePerDay: 100,
      days: 1,
    });

    // Pesos: Mercado Pago Argentina solo cobra en pesos, así que el defecto
    // tiene que ser una moneda que se pueda cobrar.
    expect(pricing.currency).toBe("ars");
    expect(pricing.commission).toBe(10);
    expect(pricing.insurance).toBe(10);
    expect(pricing.sena).toBe(30); // 30% del alquiler (100)
    expect(pricing.deposit).toBe(200);
  });

  it("toma DEPOSIT_DEFAULT antes que el nombre viejo en dólares", () => {
    const valores: Record<string, string> = {
      DEPOSIT_DEFAULT: "150000",
      DEPOSIT_DEFAULT_USD: "200",
    };
    const config = { get: (clave: string) => valores[clave] };
    const pricing = new PricingService(config as never).computeBooking({
      pricePerDay: 100,
      days: 1,
    });
    expect(pricing.deposit).toBe(150000);
  });

  it("rejects non-positive day counts", () => {
    expect(() =>
      makeService().computeBooking({ pricePerDay: 100, days: 0 }),
    ).toThrow();
  });
});
