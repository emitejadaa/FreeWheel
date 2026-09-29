import { MockPaymentsProvider } from "./mock-payments.provider";

/**
 * El proveedor de pagos sin red. Lo que se prueba acá es una sola cosa: que un
 * evento de webhook SIN firma verificada no se acepte en producción.
 *
 * Por qué importa: el webhook es lo que marca una reserva como pagada. Si se
 * acepta un evento sin verificar, cualquiera que sepa la URL manda un
 * "payment_intent.succeeded" y figura como que pagó. En los tests el camino
 * permisivo hace falta para poder recorrer el circuito sin una cuenta de
 * Stripe; en producción es una puerta abierta, y no hay variable que la abra.
 */
function crear(env: Record<string, string>): MockPaymentsProvider {
  const config = { get: (clave: string) => env[clave] };
  return new MockPaymentsProvider(config as never);
}

const EVENTO = Buffer.from(
  JSON.stringify({
    id: "evt_falso",
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_falso" } },
  }),
);

describe("MockPaymentsProvider y los webhooks sin firma", () => {
  it("en desarrollo acepta el evento sin firma (hace falta para probar el flujo)", () => {
    const provider = crear({ NODE_ENV: "development" });
    const evento = provider.constructWebhookEvent(EVENTO, undefined);
    expect(evento.type).toBe("payment_intent.succeeded");
  });

  it("en producción lo RECHAZA y dice qué configurar", () => {
    const provider = crear({ NODE_ENV: "production" });
    expect(() => provider.constructWebhookEvent(EVENTO, undefined)).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
  });

  it("en producción tampoco alcanza con mandar una firma cualquiera", () => {
    // Sin secreto configurado no hay con qué verificar: la firma que venga no
    // significa nada, así que el resultado tiene que ser el mismo.
    const provider = crear({ NODE_ENV: "production" });
    expect(() =>
      provider.constructWebhookEvent(EVENTO, "t=1,v1=inventada"),
    ).toThrow(/sin firma verificada/i);
  });

  it("NINGUNA variable de entorno vuelve a abrir esa puerta", () => {
    // ALLOW_UNSIGNED_WEBHOOKS existió y se sacó. Un agujero que se abre con
    // una variable es un agujero que un día queda abierto sin que nadie se
    // acuerde, y lo que abría era "cualquiera puede declarar una reserva como
    // pagada". Este test está para que nadie lo reponga sin darse cuenta.
    const provider = crear({
      NODE_ENV: "production",
      ALLOW_UNSIGNED_WEBHOOKS: "true",
    });
    expect(() => provider.constructWebhookEvent(EVENTO, undefined)).toThrow(
      /sin firma verificada/i,
    );
  });

  it("con el secreto configurado, una firma inventada no pasa", () => {
    // Este es el camino de verdad: la verificación de Stripe es criptográfica y
    // corre sin red, así que en las pruebas se ejercita igual que en producción.
    const provider = crear({
      NODE_ENV: "production",
      STRIPE_WEBHOOK_SECRET: "whsec_de_prueba",
    });
    expect(() =>
      provider.constructWebhookEvent(EVENTO, "t=1,v1=inventada"),
    ).toThrow();
  });
});
