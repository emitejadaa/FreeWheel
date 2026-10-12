import { ConfigService } from "@nestjs/config";
import { VerificationService } from "./verification.service";

/**
 * El código del teléfono en la respuesta HTTP es una comodidad para la demo.
 * En producción no puede salir nunca: con el código a la vista, verificar el
 * teléfono no prueba tener el teléfono.
 */
describe("VerificationService: el código en la respuesta", () => {
  function servicio(env: Record<string, string>) {
    const user = { id: "u1", email: "ana@test.com", phone: "+5491130000001" };
    const prisma = {
      user: { findUnique: () => Promise.resolve(user) },
      verificationCode: {
        updateMany: () => Promise.resolve({ count: 0 }),
        create: () => Promise.resolve({}),
      },
    };
    const email = { sendPhoneVerificationCode: () => Promise.resolve() };
    const sms = { isMock: true };
    const config = {
      get: (clave: string) => env[clave],
    } as unknown as ConfigService;
    return new VerificationService(
      prisma as never,
      email as never,
      sms as never,
      {} as never,
      {} as never,
      config,
    );
  }

  it("fuera de producción, con la variable prendida, viaja", async () => {
    const res = await servicio({
      NODE_ENV: "development",
      VERIFICATION_CODE_IN_RESPONSE: "true",
    }).requestPhoneCode("u1");
    expect(res.code).toMatch(/^\d{6}$/);
  });

  it("en producción no viaja aunque la variable esté prendida", async () => {
    const res = await servicio({
      NODE_ENV: "production",
      VERIFICATION_CODE_IN_RESPONSE: "true",
    }).requestPhoneCode("u1");
    expect(res.code).toBeUndefined();
  });
});
