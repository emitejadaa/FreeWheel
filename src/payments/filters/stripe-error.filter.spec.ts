import { HttpStatus } from "@nestjs/common";
import Stripe from "stripe";
import { StripeErrorFilter } from "./stripe-error.filter";

/**
 * QUÉ LE LLEGA A LA PERSONA CUANDO STRIPE RECHAZA ALGO
 *
 * El filtro decide, para cada error del procesador, dos cosas que no son la
 * misma: qué se escribe en el log —donde hay que poder reconstruir el problema—
 * y qué se le muestra a quien está del otro lado de la pantalla.
 *
 * Lo que se prueba acá es la separación entre "esto lo podés resolver vos" y
 * "esto es nuestro". El caso que lo motivó: a un dueño que quería dar de alta
 * sus datos de cobro le aparecía, en inglés, el mensaje de Stripe pidiéndole que
 * se diera de alta como plataforma de Connect. Las dos cosas que puede hacer con
 * eso son igual de malas: creer que hizo algo mal, o ir a Stripe a crear una
 * plataforma que no tiene nada que ver con él.
 */
describe("StripeErrorFilter — qué se le dice a quien está del otro lado", () => {
  const filtro = new StripeErrorFilter();

  /** Corre el filtro y devuelve lo que se le contestó al cliente. */
  const contestar = (error: Stripe.errors.StripeError) => {
    let enviado: { statusCode: number; code: string; message: string } | null =
      null;
    const alLog: string[] = [];
    jest
      .spyOn(filtro["logger"], "error")
      .mockImplementation((m: unknown) => alLog.push(String(m)));

    const host = {
      switchToHttp: () => ({
        getResponse: () => ({
          status: (statusCode: number) => ({
            json: (cuerpo: { code: string; message: string }) => {
              enviado = { statusCode, ...cuerpo };
            },
          }),
        }),
        getRequest: () => ({ method: "POST", originalUrl: "/payments/x" }),
      }),
    };
    filtro.catch(error, host as never);
    return { enviado: enviado!, alLog };
  };

  const invalido = (mensaje: string) =>
    new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      message: mensaje,
    });

  // ── Connect sin habilitar ────────────────────────────────────────────────

  const DE_STRIPE =
    "You can only create new accounts if you've signed up for Connect, " +
    "which you can do at https://dashboard.stripe.com/connect.";

  it("reconoce el rechazo de Connect sin habilitar", () => {
    expect(StripeErrorFilter.esConnectSinHabilitar(DE_STRIPE)).toBe(true);
    // Sin distinguir mayúsculas, y por cualquiera de las dos señales.
    expect(
      StripeErrorFilter.esConnectSinHabilitar("SIGNED UP FOR CONNECT"),
    ).toBe(true);
    expect(
      StripeErrorFilter.esConnectSinHabilitar(
        "ver dashboard.stripe.com/connect",
      ),
    ).toBe(true);
  });

  it("y NO confunde cualquier otro rechazo con ese", () => {
    for (const otro of [
      "Invalid currency: usd",
      "The amount is too large",
      "No such account: acct_123",
      "",
    ]) {
      expect(StripeErrorFilter.esConnectSinHabilitar(otro)).toBe(false);
    }
  });

  it("AL DUEÑO NO SE LE PIDE QUE ARREGLE ALGO QUE NO ES SUYO", () => {
    const { enviado } = contestar(invalido(DE_STRIPE));

    // Nada del mensaje para desarrolladores llega a la pantalla.
    expect(enviado.message).not.toContain("dashboard.stripe.com");
    expect(enviado.message).not.toContain("signed up for Connect");
    expect(enviado.message).not.toMatch(/you can/i);

    // Y sí se dice lo único que le sirve saber: que no es suyo, y qué
    // significa para él mientras tanto.
    expect(enviado.message).toContain("No es algo que puedas resolver vos");
    expect(enviado.message).toContain("publicar tus autos igual");
    expect(enviado.code).toBe("STRIPE_CONNECT_NOT_ENABLED");
  });

  it("es un 503 y no un 400: no es un pedido mal armado, es una configuración", () => {
    const { enviado } = contestar(invalido(DE_STRIPE));
    expect(enviado.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it("EL LOG SÍ DICE QUÉ HAY QUE HACER, con todas las letras", () => {
    // Quien administra el deploy es el único que puede resolverlo, y lee el
    // log. Ahí va el mensaje crudo de Stripe y la acción concreta.
    const { alLog } = contestar(invalido(DE_STRIPE));
    expect(alLog[0]).toContain("signed up for Connect");
    expect(alLog[0]).toContain("dashboard.stripe.com/connect");
    expect(alLog[0]).toContain("STRIPE_SECRET_KEY");
  });

  // ── Lo que ya funcionaba y tiene que seguir igual ────────────────────────

  it("otro pedido invalido sigue mostrando el detalle de Stripe", () => {
    // Ese detalle es útil: dice exactamente qué estaba mal en el pedido.
    const { enviado } = contestar(invalido("Invalid currency: usd"));
    expect(enviado.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(enviado.code).toBe("STRIPE_REQUEST_INVALID");
    expect(enviado.message).toContain("Invalid currency: usd");
  });

  it("la tarjeta rechazada sigue siendo un 402 con el texto de Stripe", () => {
    const error = new Stripe.errors.StripeCardError({
      type: "card_error",
      message: "Tu tarjeta fue rechazada.",
      code: "card_declined",
    });
    const { enviado } = contestar(error);
    expect(enviado.statusCode).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(enviado.message).toBe("Tu tarjeta fue rechazada.");
  });

  it("EL ERROR DE NUESTRA CLAVE SIGUE SIN SALIR DE ACÁ", () => {
    const error = new Stripe.errors.StripeAuthenticationError({
      type: "authentication_error",
      message: "Invalid API Key provided: sk_test_****1234",
    });
    const { enviado, alLog } = contestar(error);
    expect(enviado.message).not.toContain("sk_test");
    expect(enviado.code).toBe("PAYMENTS_NOT_CONFIGURED");
    expect(alLog[0]).toContain("sk_test");
  });
});
