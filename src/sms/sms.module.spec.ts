import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { SmsModule } from "./sms.module";
import { SmsService } from "./sms.service";
import { TwilioSmsProvider } from "./providers/twilio-sms.provider";

/**
 * Qué se prueba acá: que elegir la pasarela de SMS por variable de entorno haga
 * lo que dice, y que una configuración a medias reviente AL ARRANCAR.
 *
 * Lo segundo es lo que importa. Con las variables a medias la app levantaría
 * igual y la falla aparecería recién cuando alguien intente verificar su
 * teléfono: quien hizo el deploy ya se fue, y el que se come el error es un
 * usuario que se queda esperando un SMS que nunca salió.
 */

/**
 * Levanta el módulo con estas variables y nada más.
 *
 * `ignoreEnvVars` es a propósito: sin eso, una variable de Twilio cargada en la
 * máquina de quien corre las pruebas se colaría y la prueba de "sin
 * TWILIO_AUTH_TOKEN no arranca" pasaría por el motivo equivocado.
 */
const conVariables = (vars: Record<string, string | undefined>) =>
  Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
        load: [() => vars],
      }),
      SmsModule,
    ],
  }).compile();

const TWILIO_COMPLETO = {
  SMS_PROVIDER: "twilio",
  TWILIO_ACCOUNT_SID: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  TWILIO_AUTH_TOKEN: "token-de-mentira",
  TWILIO_FROM_NUMBER: "+15550001111",
};

describe("SmsModule: elegir la pasarela", () => {
  it("sin variable, usa el mock y el código va por email", async () => {
    const mod = await conVariables({});
    const sms = mod.get(SmsService);
    expect(sms.providerName).toBe("mock");
    // isMock es lo que hace que VerificationService mande el código por email.
    expect(sms.isMock).toBe(true);
  });

  it("con SMS_PROVIDER=twilio y todo cargado, usa Twilio", async () => {
    const mod = await conVariables(TWILIO_COMPLETO);
    const sms = mod.get(SmsService);
    expect(sms.providerName).toBe("twilio");
    // Deja de ser mock: a partir de acá el código sale por SMS de verdad.
    expect(sms.isMock).toBe(false);
  });

  it("acepta un Messaging Service en lugar de un número", async () => {
    const mod = await conVariables({
      SMS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: TWILIO_COMPLETO.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: TWILIO_COMPLETO.TWILIO_AUTH_TOKEN,
      TWILIO_MESSAGING_SERVICE_SID: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    });
    expect(mod.get(SmsService).providerName).toBe("twilio");
  });

  it.each([
    ["TWILIO_ACCOUNT_SID"],
    ["TWILIO_AUTH_TOKEN"],
    ["TWILIO_FROM_NUMBER"],
  ])("sin %s no arranca, en vez de fallar en el primer SMS", async (falta) => {
    const vars: Record<string, string | undefined> = { ...TWILIO_COMPLETO };
    delete vars[falta];
    await expect(conVariables(vars)).rejects.toThrow(/TWILIO_/);
  });

  it("una pasarela que no existe no arranca", async () => {
    await expect(
      conVariables({ SMS_PROVIDER: "carrier-pigeon" }),
    ).rejects.toThrow(/Unknown SMS_PROVIDER/);
  });
});

describe("TwilioSmsProvider: el pedido que sale", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  /** Reemplaza fetch y devuelve lo que se le pasó. */
  const espiarFetch = (respuesta: Partial<Response>) => {
    const llamadas: { url: string; init: RequestInit }[] = [];
    global.fetch = ((url: string, init: RequestInit) => {
      llamadas.push({ url, init });
      return Promise.resolve({
        ok: true,
        status: 201,
        text: () => Promise.resolve(""),
        ...respuesta,
      } as Response);
    }) as unknown as typeof fetch;
    return llamadas;
  };

  it("manda el código al número, con el remitente y la autenticación", async () => {
    const llamadas = espiarFetch({});
    const proveedor = new TwilioSmsProvider(
      "ACsid",
      "token",
      "+15550001111",
      false,
    );
    await proveedor.sendVerificationCode("+5491133334444", "123456");

    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/ACsid/Messages.json",
    );
    const cuerpo = new URLSearchParams(llamadas[0].init.body as string);
    expect(cuerpo.get("To")).toBe("+5491133334444");
    expect(cuerpo.get("From")).toBe("+15550001111");
    expect(cuerpo.get("Body")).toContain("123456");
    // Autenticación básica: usuario = SID, contraseña = token.
    const headers = llamadas[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("ACsid:token").toString("base64")}`,
    );
  });

  it("con un Messaging Service manda MessagingServiceSid y no From", async () => {
    const llamadas = espiarFetch({});
    const proveedor = new TwilioSmsProvider(
      "ACsid",
      "token",
      "MGservicio",
      true,
    );
    await proveedor.sendVerificationCode("+5491133334444", "123456");

    const cuerpo = new URLSearchParams(llamadas[0].init.body as string);
    expect(cuerpo.get("MessagingServiceSid")).toBe("MGservicio");
    expect(cuerpo.get("From")).toBeNull();
  });

  it("si Twilio rechaza el envío, lanza en vez de hacer de cuenta que salió", async () => {
    // Es la regla que importa: quien llama guarda el código y le dice a la
    // persona "te mandamos un SMS". Si esto devolviera normal, esa persona
    // esperaría para siempre un mensaje que nunca salió.
    espiarFetch({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve('{"code":21211,"message":"Invalid To number"}'),
    });
    const proveedor = new TwilioSmsProvider(
      "ACsid",
      "token",
      "+15550001111",
      false,
    );
    await expect(
      proveedor.sendVerificationCode("+000", "123456"),
    ).rejects.toThrow();
  });

  it("el motivo crudo de Twilio no viaja al usuario", async () => {
    // Trae el estado de NUESTRA cuenta (sin saldo, país bloqueado). Va al log.
    espiarFetch({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Account AC123 has insufficient funds"),
    });
    const proveedor = new TwilioSmsProvider(
      "ACsid",
      "token",
      "+15550001111",
      false,
    );
    await expect(
      proveedor.sendVerificationCode("+5491133334444", "123456"),
    ).rejects.toThrow(/Revisá que esté bien escrito/);
  });

  it("si no se llega a Twilio, tampoco hace de cuenta que salió", async () => {
    global.fetch = (() =>
      Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch;
    const proveedor = new TwilioSmsProvider(
      "ACsid",
      "token",
      "+15550001111",
      false,
    );
    await expect(
      proveedor.sendVerificationCode("+5491133334444", "123456"),
    ).rejects.toThrow(/Probá de nuevo/);
  });
});
