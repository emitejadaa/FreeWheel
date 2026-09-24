import { MockPaymentsProvider } from "./mock-payments.provider";
import type { CreatePaymentInput } from "./payment-provider.interface";
import { signMercadoPagoNotification } from "./mercadopago/mercadopago.shared";

const COBRADOR = { userId: "mp_user_dueno", accessToken: "TEST-dueno" };

function pago(
  token: string,
  extra: Partial<CreatePaymentInput> = {},
): CreatePaymentInput {
  return {
    bookingId: "reserva-1",
    kind: "CHECKOUT",
    amountMinor: 330_000,
    currency: "ars",
    applicationFeeMinor: 60_000,
    capture: true,
    card: {
      token,
      paymentMethodId: "visa",
      installments: 1,
      payer: { email: "inquilino@test.com" },
    },
    collector: COBRADOR,
    description: "reserva",
    externalReference: "reserva-1",
    idempotencyKey: `clave-${token}`,
    ...extra,
  };
}

/**
 * El provider de las pruebas tiene que comportarse como Mercado Pago en lo
 * que importa: quién decide el resultado (el nombre del titular, como en el
 * sandbox), qué pasa con una clave de idempotencia repetida, y que una
 * reserva de fondos se autoriza, se captura en parte o se suelta.
 */
describe("MockPaymentsProvider (se comporta como Mercado Pago)", () => {
  it("el nombre del titular decide el resultado, como en el sandbox", async () => {
    const mp = new MockPaymentsProvider();
    await expect(mp.createPayment(pago("tok_APRO_1"))).resolves.toMatchObject({
      status: "approved",
      statusDetail: "accredited",
    });
    await expect(mp.createPayment(pago("tok_FUND_1"))).resolves.toMatchObject({
      status: "rejected",
      statusDetail: "cc_rejected_insufficient_amount",
      failure: { code: "cc_rejected_insufficient_amount" },
    });
    await expect(mp.createPayment(pago("tok_CONT_1"))).resolves.toMatchObject({
      status: "in_process",
    });
  });

  it("la misma clave de idempotencia devuelve el mismo pago, no cobra dos veces", async () => {
    const mp = new MockPaymentsProvider();
    const primero = await mp.createPayment(pago("tok_APRO_x"));
    const segundo = await mp.createPayment(pago("tok_APRO_x"));
    expect(segundo.id).toBe(primero.id);
  });

  it("una reserva de fondos se autoriza, se captura en parte y no más de lo retenido", async () => {
    const mp = new MockPaymentsProvider();
    const reserva = await mp.createPayment(
      pago("tok_APRO_dep", {
        kind: "DEPOSIT_HOLD",
        capture: false,
        amountMinor: 20_000,
      }),
    );
    expect(reserva.status).toBe("authorized");
    expect(reserva.captureBefore).toBeInstanceOf(Date);

    await expect(
      mp.capturePayment(COBRADOR, reserva.id, 99_999, "k"),
    ).rejects.toThrow();
    const capturada = await mp.capturePayment(COBRADOR, reserva.id, 5_000, "k");
    expect(capturada).toMatchObject({
      status: "approved",
      capturedMinor: 5_000,
    });
  });

  it("una devolución parcial deja el pago aprobado y una total lo marca devuelto", async () => {
    const mp = new MockPaymentsProvider();
    const cobro = await mp.createPayment(pago("tok_APRO_r"));
    await mp.refundPayment(COBRADOR, cobro.id, 100_000, "r1");
    expect(mp.consultar(cobro.id)).toMatchObject({
      status: "approved",
      refundedMinor: 100_000,
    });
    await mp.refundPayment(COBRADOR, cobro.id, null, "r2");
    expect(mp.consultar(cobro.id)).toMatchObject({ status: "refunded" });
  });

  it("verifica la firma de los avisos con la MISMA función que producción", () => {
    const mp = new MockPaymentsProvider({
      get: () => "secreto-de-avisos",
    } as never);
    const firma = signMercadoPagoNotification({
      secret: "secreto-de-avisos",
      dataId: "123",
      requestId: "req-1",
    });
    expect(() =>
      mp.verifyNotificationSignature({
        signatureHeader: firma,
        requestId: "req-1",
        dataId: "123",
      }),
    ).not.toThrow();
    expect(() =>
      mp.verifyNotificationSignature({
        signatureHeader: firma,
        requestId: "req-1",
        dataId: "999",
      }),
    ).toThrow();
  });
});
