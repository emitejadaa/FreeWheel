import {
  MercadoPagoApiError,
  MercadoPagoPaymentsProvider,
} from "./mercadopago.provider";

/**
 * Lo que el provider le MANDA a Mercado Pago.
 *
 * Sin credenciales no se puede probar contra la API real, así que se prueba
 * lo único que depende de este código: la forma exacta de cada pedido. Un
 * importe en centavos donde van pesos, una comisión que no viaja o una clave
 * de idempotencia que se reusa son errores de plata que ningún otro test ve.
 */

interface Llamada {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function armar(
  respuestas: Array<{ status: number; body: unknown }>,
  config: Record<string, string> = {},
) {
  const llamadas: Llamada[] = [];
  const fetchFalso = jest.fn((url: string, init: RequestInit) => {
    llamadas.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : null,
    });
    const r = respuestas.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(r.body), { status: r.status }),
    );
  });
  const valores: Record<string, string> = {
    MP_CLIENT_ID: "app-123",
    MP_CLIENT_SECRET: "secreto-app",
    MP_WEBHOOK_SECRET: "avisos",
    ...config,
  };
  const provider = new MercadoPagoPaymentsProvider(
    { get: (k: string) => valores[k] } as never,
    fetchFalso as unknown as typeof fetch,
  );
  return { provider, llamadas, fetchFalso };
}

const DUENO = { userId: "777", accessToken: "APP_USR-dueno" };

const PAGO_APROBADO = {
  id: 555,
  status: "approved",
  status_detail: "accredited",
  transaction_amount: 3300,
  currency_id: "ARS",
  external_reference: "reserva-1",
  collector_id: 777,
};

describe("MercadoPagoPaymentsProvider: lo que se manda a la API", () => {
  it("crea el pago con el token DEL DUEÑO, en pesos, con la comisión de FreeWheel", async () => {
    const { provider, llamadas } = armar([
      { status: 201, body: PAGO_APROBADO },
    ]);

    const resultado = await provider.createPayment({
      bookingId: "reserva-1",
      kind: "CHECKOUT",
      amountMinor: 330_000,
      currency: "ars",
      applicationFeeMinor: 60_000,
      capture: true,
      card: {
        token: "tok-tarjeta",
        paymentMethodId: "visa",
        issuerId: "310",
        installments: 3,
        payer: {
          email: "inquilino@test.com",
          identification: { type: "DNI", number: "12345678" },
        },
        deviceSessionId: "armor.dispositivo",
      },
      collector: DUENO,
      description: "Alquiler",
      externalReference: "reserva-1",
      statementDescriptor: "FREEWHEEL",
      idempotencyKey: "clave-unica",
    });

    expect(resultado).toMatchObject({ id: "555", status: "approved" });
    const [pedido] = llamadas;
    expect(pedido.method).toBe("POST");
    expect(pedido.url).toBe("https://api.mercadopago.com/v1/payments");
    expect(pedido.headers.Authorization).toBe("Bearer APP_USR-dueno");
    expect(pedido.headers["X-Idempotency-Key"]).toBe("clave-unica");
    expect(pedido.headers["X-meli-session-id"]).toBe("armor.dispositivo");
    expect(pedido.body).toMatchObject({
      // Pesos con decimales, NO centavos: 330000 centavos son 3300 pesos.
      transaction_amount: 3300,
      application_fee: 600,
      token: "tok-tarjeta",
      installments: 3,
      payment_method_id: "visa",
      issuer_id: 310,
      capture: true,
      external_reference: "reserva-1",
      statement_descriptor: "FREEWHEEL",
      payer: {
        email: "inquilino@test.com",
        identification: { type: "DNI", number: "12345678" },
      },
    });
  });

  it("el depósito es una reserva de fondos y no lleva comisión", async () => {
    const { provider, llamadas } = armar([
      {
        status: 201,
        body: {
          ...PAGO_APROBADO,
          status: "authorized",
          transaction_amount: 200,
        },
      },
    ]);
    const r = await provider.createPayment({
      bookingId: "reserva-1",
      kind: "DEPOSIT_HOLD",
      amountMinor: 20_000,
      currency: "ars",
      applicationFeeMinor: 0,
      capture: false,
      card: {
        token: "t",
        paymentMethodId: "visa",
        installments: 1,
        payer: { email: "a@b.com" },
      },
      collector: DUENO,
      description: "Depósito",
      externalReference: "reserva-1",
      idempotencyKey: "k",
    });
    expect(r.status).toBe("authorized");
    expect(r.captureBefore).toBeInstanceOf(Date);
    expect(llamadas[0].body).toMatchObject({
      capture: false,
      transaction_amount: 200,
    });
    expect(llamadas[0].body).not.toHaveProperty("application_fee");
  });

  it("captura parcial, cancelación y devolución van a los caminos correctos", async () => {
    const { provider, llamadas } = armar([
      { status: 200, body: { ...PAGO_APROBADO, transaction_amount: 50 } },
      { status: 200, body: { ...PAGO_APROBADO, status: "cancelled" } },
      { status: 201, body: { id: 9, amount: 24, status: "approved" } },
      { status: 201, body: { id: 10, amount: 3300, status: "approved" } },
    ]);
    await provider.capturePayment(DUENO, "555", 5_000, "cap");
    await provider.cancelPayment(DUENO, "555", "can");
    const parcial = await provider.refundPayment(DUENO, "555", 2_400, "dev1");
    await provider.refundPayment(DUENO, "555", null, "dev2");

    expect(llamadas[0]).toMatchObject({
      method: "PUT",
      url: "https://api.mercadopago.com/v1/payments/555",
      body: { capture: true, transaction_amount: 50 },
    });
    expect(llamadas[1]).toMatchObject({
      method: "PUT",
      body: { status: "cancelled" },
    });
    expect(llamadas[2]).toMatchObject({
      method: "POST",
      url: "https://api.mercadopago.com/v1/payments/555/refunds",
      body: { amount: 24 },
    });
    expect(parcial.amountMinor).toBe(2_400);
    // Devolución total: el cuerpo va vacío, como pide la API.
    expect(llamadas[3].body).toEqual({});
    // Cada operación con su propia clave: ninguna se arrastra a la siguiente.
    expect(llamadas.map((l) => l.headers["X-Idempotency-Key"])).toEqual([
      "cap",
      "can",
      "dev1",
      "dev2",
    ]);
  });

  it("arma la URL de vinculación con state y PKCE", () => {
    const { provider } = armar([]);
    const url = new URL(
      provider.authorizationUrl({
        state: "estado-cifrado",
        redirectUri: "https://api.test/payments/mercadopago/oauth/callback",
        codeChallenge: "desafio",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://auth.mercadopago.com/authorization",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "app-123",
      response_type: "code",
      platform_id: "mp",
      state: "estado-cifrado",
      code_challenge: "desafio",
      code_challenge_method: "S256",
    });
  });

  it("en modo de prueba pide credenciales de prueba al canjear el código", async () => {
    const { provider, llamadas } = armar([
      {
        status: 200,
        body: {
          access_token: "TEST-acceso",
          refresh_token: "TG-renovar",
          public_key: "TEST-publica",
          user_id: 777,
          expires_in: 15_552_000,
          live_mode: false,
        },
      },
    ]);
    const credenciales = await provider.exchangeAuthorizationCode({
      code: "TG-codigo",
      redirectUri: "https://api.test/cb",
      codeVerifier: "verificador",
    });
    expect(llamadas[0].url).toBe("https://api.mercadopago.com/oauth/token");
    expect(llamadas[0].body).toEqual({
      client_id: "app-123",
      client_secret: "secreto-app",
      grant_type: "authorization_code",
      code: "TG-codigo",
      redirect_uri: "https://api.test/cb",
      code_verifier: "verificador",
      test_token: "true",
    });
    expect(credenciales).toMatchObject({
      userId: "777",
      accessToken: "TEST-acceso",
      publicKey: "TEST-publica",
      liveMode: false,
    });
  });

  it("en producción NO pide credenciales de prueba", async () => {
    const { provider, llamadas } = armar(
      [{ status: 200, body: { access_token: "APP_USR-x", user_id: 1 } }],
      { MP_TEST_MODE: "false" },
    );
    expect(provider.liveMode).toBe(true);
    await provider.exchangeAuthorizationCode({ code: "c", redirectUri: "r" });
    expect(llamadas[0].body).toMatchObject({ test_token: "false" });
  });

  it("traduce un error de la API y reintenta solo lo que vale la pena", async () => {
    const { provider, fetchFalso } = armar([
      {
        status: 400,
        body: {
          message: "invalid card token",
          error: "bad_request",
          cause: [{ code: 2006, description: "Card Token not found" }],
        },
      },
    ]);
    const error = await provider
      .getPayment(DUENO, "1")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MercadoPagoApiError);
    expect(error).toMatchObject({
      httpStatus: 400,
      code: "2006",
      message: "Card Token not found",
      retryable: false,
    });
    // Un 400 no se reintenta: pedir lo mismo da el mismo error.
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });

  it("un 500 se reintenta una vez con la MISMA clave de idempotencia", async () => {
    const { provider, llamadas } = armar([
      { status: 500, body: { message: "boom" } },
      { status: 200, body: PAGO_APROBADO },
    ]);
    const r = await provider.capturePayment(
      DUENO,
      "555",
      330_000,
      "misma-clave",
    );
    expect(r.status).toBe("approved");
    expect(llamadas).toHaveLength(2);
    expect(llamadas[0].headers["X-Idempotency-Key"]).toBe("misma-clave");
    expect(llamadas[1].headers["X-Idempotency-Key"]).toBe("misma-clave");
  });

  it("sin credenciales de la aplicación no arma nada de OAuth", () => {
    const { provider } = armar([], { MP_CLIENT_ID: "", MP_CLIENT_SECRET: "" });
    expect(() =>
      provider.authorizationUrl({ state: "s", redirectUri: "r" }),
    ).toThrow(MercadoPagoApiError);
  });
});
