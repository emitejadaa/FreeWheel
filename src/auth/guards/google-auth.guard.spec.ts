import { ExecutionContext, ServiceUnavailableException } from "@nestjs/common";
import { GoogleAuthGuard, googleLoginConfigurado } from "./google-auth.guard";

/**
 * Lo que se prueba acá es lo que pasa cuando el servidor NO tiene cargadas las
 * credenciales de Google, que es como estuvo el deploy y como va a volver a
 * estar cualquier instalación nueva.
 *
 * Sin credenciales la estrategia de passport no se registra (auth.module.ts), y
 * entonces /auth/google tiraba `Unknown authentication strategy "google"`, que
 * al navegador le llega como un "Internal server error" pelado. Un problema de
 * configuración disfrazado de servidor roto.
 */
describe("GoogleAuthGuard sin credenciales", () => {
  const original = {
    id: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.GOOGLE_CLIENT_SECRET,
  };

  const contexto = {} as ExecutionContext;

  afterEach(() => {
    process.env.GOOGLE_CLIENT_ID = original.id;
    process.env.GOOGLE_CLIENT_SECRET = original.secret;
    if (original.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
    if (original.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  });

  it("says the button is not configured instead of blowing up with a 500", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;

    const guard = new GoogleAuthGuard();

    expect(() => guard.canActivate(contexto)).toThrow(
      ServiceUnavailableException,
    );
  });

  it("names the two variables that are missing, so it can be fixed", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;

    const guard = new GoogleAuthGuard();
    let respuesta: unknown;
    try {
      guard.canActivate(contexto);
    } catch (error) {
      respuesta = (error as ServiceUnavailableException).getResponse();
    }

    expect(respuesta).toMatchObject({ code: "GOOGLE_LOGIN_UNAVAILABLE" });
    expect(JSON.stringify(respuesta)).toContain("GOOGLE_CLIENT_ID");
    expect(JSON.stringify(respuesta)).toContain("GOOGLE_CLIENT_SECRET");
  });

  it("una sola de las dos variables no alcanza", () => {
    // Media configuración es lo mismo que ninguna: passport necesita las dos, y
    // dejar pasar el pedido acá lo devolvería al error incomprensible.
    process.env.GOOGLE_CLIENT_ID = "algo";
    delete process.env.GOOGLE_CLIENT_SECRET;

    expect(googleLoginConfigurado()).toBe(false);
  });

  it("con las dos cargadas, el guardia no se mete", () => {
    process.env.GOOGLE_CLIENT_ID = "algo";
    process.env.GOOGLE_CLIENT_SECRET = "otra-cosa";

    expect(googleLoginConfigurado()).toBe(true);
  });
});
