import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AccountDeletionPolicy } from "./account-deletion.policy";

/** ConfigService mínimo: solo lee de un objeto plano. */
function policy(
  env: Record<string, string | undefined>,
): AccountDeletionPolicy {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new AccountDeletionPolicy(config);
}

describe("AccountDeletionPolicy", () => {
  const NODE_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = NODE_ENV;
  });

  it("en producción NO se borran cuentas, sin que nadie configure nada", () => {
    const p = policy({ NODE_ENV: "production" });
    expect(p.enabled).toBe(false);
    expect(() => p.assertAllowed()).toThrow(ForbiddenException);
  });

  it("fuera de producción sí, que es donde se arman las cuentas de demo", () => {
    expect(policy({ NODE_ENV: "development" }).enabled).toBe(true);
    expect(policy({ NODE_ENV: "test" }).enabled).toBe(true);
  });

  it("ALLOW_ACCOUNT_HARD_DELETE manda sobre el entorno, en los dos sentidos", () => {
    expect(
      policy({ NODE_ENV: "production", ALLOW_ACCOUNT_HARD_DELETE: "true" })
        .enabled,
    ).toBe(true);
    expect(
      policy({ NODE_ENV: "development", ALLOW_ACCOUNT_HARD_DELETE: "false" })
        .enabled,
    ).toBe(false);
  });

  it("un valor que no es ni true ni false no cambia lo que decide el entorno", () => {
    expect(
      policy({ NODE_ENV: "production", ALLOW_ACCOUNT_HARD_DELETE: "quizás" })
        .enabled,
    ).toBe(false);
    expect(
      policy({ NODE_ENV: "development", ALLOW_ACCOUNT_HARD_DELETE: "" })
        .enabled,
    ).toBe(true);
  });

  it("sin NODE_ENV asume desarrollo (no es un servidor de producción)", () => {
    delete process.env.NODE_ENV;
    expect(policy({}).enabled).toBe(true);
  });

  it("el 403 explica qué hacer en su lugar: suspender o dar de baja", () => {
    expect(() => policy({ NODE_ENV: "production" }).assertAllowed()).toThrow(
      /suspenden o se dan de baja/,
    );
  });
});
