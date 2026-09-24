import { createHmac } from "crypto";
import {
  buildSignatureManifest,
  huellaDeTarjeta,
  leerPago,
  parseMercadoPagoNotification,
  vencimientoDeReserva,
  verifyMercadoPagoSignature,
} from "./mercadopago.shared";

const SECRETO = "clave-de-la-aplicacion";

/** La firma que calcularía Mercado Pago, a mano, sin usar el código probado. */
function firmar(manifiesto: string, ts: string): string {
  const v1 = createHmac("sha256", SECRETO).update(manifiesto).digest("hex");
  return `ts=${ts},v1=${v1}`;
}

const AHORA = new Date("2026-09-24T12:00:00.000Z");
const TS = String(Math.floor(AHORA.getTime() / 1000));

describe("verifyMercadoPagoSignature", () => {
  it("acepta la firma armada con el manifiesto exacto de Mercado Pago", () => {
    const cabecera = firmar(`id:123456;request-id:abc-1;ts:${TS};`, TS);
    expect(() =>
      verifyMercadoPagoSignature({
        secret: SECRETO,
        signatureHeader: cabecera,
        requestId: "abc-1",
        dataId: "123456",
        now: AHORA,
      }),
    ).not.toThrow();
  });

  it("pasa a minúsculas un id con letras, como pide Mercado Pago", () => {
    // Firmado con minúsculas; el aviso trae el id con mayúsculas.
    const cabecera = firmar(`id:abc123;request-id:r;ts:${TS};`, TS);
    expect(() =>
      verifyMercadoPagoSignature({
        secret: SECRETO,
        signatureHeader: cabecera,
        requestId: "r",
        dataId: "ABC123",
        now: AHORA,
      }),
    ).not.toThrow();
  });

  it("saca del manifiesto lo que falta, en vez de dejarlo vacío", () => {
    expect(
      buildSignatureManifest({ dataId: "1", requestId: null, ts: "9" }),
    ).toBe("id:1;ts:9;");
  });

  it("rechaza un hash que no coincide, otro id, o sin cabecera", () => {
    const cabecera = firmar(`id:1;request-id:r;ts:${TS};`, TS);
    for (const caso of [
      { signatureHeader: cabecera, requestId: "r", dataId: "2" },
      { signatureHeader: cabecera, requestId: "otra", dataId: "1" },
      { signatureHeader: null, requestId: "r", dataId: "1" },
      { signatureHeader: "ts=1,v1=deadbeef", requestId: "r", dataId: "1" },
    ]) {
      expect(() =>
        verifyMercadoPagoSignature({ secret: SECRETO, now: AHORA, ...caso }),
      ).toThrow();
    }
  });

  it("rechaza un aviso de hace más de 72 horas", () => {
    const viejo = String(Math.floor(AHORA.getTime() / 1000) - 73 * 3600);
    const cabecera = firmar(`id:1;request-id:r;ts:${viejo};`, viejo);
    expect(() =>
      verifyMercadoPagoSignature({
        secret: SECRETO,
        signatureHeader: cabecera,
        requestId: "r",
        dataId: "1",
        now: AHORA,
      }),
    ).toThrow(/viejo/);
  });

  it("sin clave configurada no acepta nada", () => {
    expect(() =>
      verifyMercadoPagoSignature({
        secret: "",
        signatureHeader: "ts=1,v1=x",
        dataId: "1",
      }),
    ).toThrow(/MP_WEBHOOK_SECRET/);
  });
});

describe("parseMercadoPagoNotification", () => {
  it("lee el formato de webhooks", () => {
    expect(
      parseMercadoPagoNotification({
        body: {
          id: 991,
          type: "payment",
          action: "payment.updated",
          data: { id: "123" },
          user_id: 777,
          live_mode: false,
        },
        query: { "data.id": "123", type: "payment" },
      }),
    ).toEqual({
      topic: "payment",
      action: "payment.updated",
      dataId: "123",
      notificationId: "991",
      collectorUserId: "777",
      liveMode: false,
    });
  });

  it("lee el formato viejo de IPN (todo en la URL)", () => {
    expect(
      parseMercadoPagoNotification({
        body: {},
        query: { topic: "chargebacks", id: "55" },
      }),
    ).toMatchObject({ topic: "chargebacks", dataId: "55" });
  });
});

describe("leerPago", () => {
  it("convierte pesos con decimales a centavos y arma la huella de la tarjeta", () => {
    const pago = leerPago({
      id: 123,
      status: "approved",
      status_detail: "accredited",
      transaction_amount: 3300.5,
      transaction_amount_refunded: 0,
      currency_id: "ARS",
      external_reference: "reserva-1",
      metadata: { kind: "checkout" },
      collector_id: 777,
      payment_method_id: "visa",
      date_approved: "2026-09-24T10:00:00.000-03:00",
      card: {
        first_six_digits: "450995",
        last_four_digits: "3704",
        expiration_month: 11,
        expiration_year: 2030,
        cardholder: { identification: { number: "12345678" } },
      },
    });
    expect(pago).toMatchObject({
      id: "123",
      status: "approved",
      amountMinor: 330_050,
      capturedMinor: 330_050,
      kind: "CHECKOUT",
      collectorId: "777",
      card: { brand: "visa", last4: "3704" },
    });
    expect(pago.card?.fingerprint).toMatch(/^mpfp_[0-9a-f]{32}$/);
  });

  it("un rechazo trae el motivo en castellano", () => {
    const pago = leerPago({
      id: 1,
      status: "rejected",
      status_detail: "cc_rejected_insufficient_amount",
      transaction_amount: 10,
    });
    expect(pago.failure).toEqual({
      code: "cc_rejected_insufficient_amount",
      message: "La tarjeta no tiene fondos suficientes.",
    });
  });
});

describe("huellaDeTarjeta y vencimientoDeReserva", () => {
  it("la misma tarjeta da la misma huella, otra tarjeta da otra", () => {
    const a = huellaDeTarjeta({
      firstSix: "450995",
      lastFour: "3704",
      expMonth: 11,
      expYear: 2030,
      holderDocument: "1",
    });
    const b = huellaDeTarjeta({
      firstSix: "450995",
      lastFour: "3704",
      expMonth: 11,
      expYear: 2030,
      holderDocument: "1",
    });
    const c = huellaDeTarjeta({
      firstSix: "503175",
      lastFour: "0604",
      expMonth: 11,
      expYear: 2030,
      holderDocument: "1",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("una reserva de fondos se da por vencida medio día antes de los 7 días", () => {
    const desde = new Date("2026-09-24T00:00:00.000Z");
    const vence = vencimientoDeReserva(desde);
    const horas = (vence.getTime() - desde.getTime()) / 3_600_000;
    expect(horas).toBe(7 * 24 - 12);
  });
});
