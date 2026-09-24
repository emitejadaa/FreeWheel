import { reconcileSplitRefund } from "./split-refund";

/**
 * Reserva de referencia: alquiler 3000, cobertura 300 (total 3300), comisión
 * 300 (10 %), seña 900. En unidades mínimas.
 */
const base = {
  totalMinor: 330_000,
  commissionMinor: 30_000,
  insuranceMinor: 30_000,
};

/** Lo que termina con cada uno, para comprobar el reparto de punta a punta. */
function repartoFinal(
  r: ReturnType<typeof reconcileSplitRefund>,
  refundMinor: number,
) {
  const fee = base.commissionMinor + base.insuranceMinor;
  const duenoDirecto = base.totalMinor - fee - r.ownerRefundedMinor;
  const freewheel = fee - r.platformRefundedMinor;
  return {
    renter: refundMinor,
    dueno: duenoDirecto + r.ownerAdjustmentMinor,
    freewheel: freewheel - r.ownerAdjustmentMinor,
  };
}

describe("reconcileSplitRefund", () => {
  it("la seña perdida: Mercado Pago reparte en proporción, y el ajuste corrige", () => {
    const r = reconcileSplitRefund({
      ...base,
      refundMinor: 240_000,
      expectedCommissionMinor: 9_000,
    });
    // Lo que descuenta Mercado Pago de cada cuenta.
    expect(r.platformRefundedMinor).toBe(43_636);
    expect(r.ownerRefundedMinor).toBe(196_364);
    // FreeWheel se quedó con 16.364 y le corresponden 9.000: el resto es del
    // dueño.
    expect(r.ownerAdjustmentMinor).toBe(7_364);

    // Y al final, cada uno con lo que dice la política.
    expect(repartoFinal(r, 240_000)).toEqual({
      renter: 240_000,
      dueno: 81_000,
      freewheel: 9_000,
    });
  });

  it("una devolución total no deja nada para ajustar", () => {
    const r = reconcileSplitRefund({
      ...base,
      refundMinor: 330_000,
      expectedCommissionMinor: 0,
    });
    expect(r.platformRefundedMinor).toBe(60_000);
    expect(r.ownerRefundedMinor).toBe(270_000);
    expect(r.ownerAdjustmentMinor).toBe(0);
    expect(repartoFinal(r, 330_000)).toEqual({
      renter: 330_000,
      dueno: 0,
      freewheel: 0,
    });
  });

  it("nunca devuelve más de lo cobrado", () => {
    const r = reconcileSplitRefund({
      ...base,
      refundMinor: 999_999,
      expectedCommissionMinor: 0,
    });
    expect(r.platformRefundedMinor + r.ownerRefundedMinor).toBe(330_000);
  });

  it("los importes raros no rompen el reparto: siempre cierra al centavo", () => {
    for (const refund of [1, 7, 12_345, 99_999, 329_999]) {
      const r = reconcileSplitRefund({
        ...base,
        refundMinor: refund,
        expectedCommissionMinor: 0,
      });
      expect(r.platformRefundedMinor + r.ownerRefundedMinor).toBe(refund);
      const final = repartoFinal(r, refund);
      expect(final.renter + final.dueno + final.freewheel).toBe(330_000);
    }
  });
});
