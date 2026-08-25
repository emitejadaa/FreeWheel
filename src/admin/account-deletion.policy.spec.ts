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

  /*
    Esto antes estaba al revés: en producción NO se podía borrar. La intención
    era que nadie borrara por error lo que quiso suspender, pero la única
    instalación que existe corre con NODE_ENV=production, así que el botón no
    aparecía en ninguna parte y no se podía ni reciclar una cuenta de prueba ni
    atender un pedido de borrado real.

    La barrera contra el borrado por error está en el panel: hay que ESCRIBIR el
    email de la cuenta. Esa se aplica en el momento y contra la cuenta concreta,
    en vez de apagar la función para siempre.
  */
  it("está habilitado por defecto, en cualquier entorno", () => {
    expect(policy({ NODE_ENV: "production" }).enabled).toBe(true);
    expect(policy({ NODE_ENV: "development" }).enabled).toBe(true);
    expect(policy({ NODE_ENV: "test" }).enabled).toBe(true);
    expect(policy({}).enabled).toBe(true);
  });

  it("ALLOW_ACCOUNT_HARD_DELETE=false lo apaga, en cualquier entorno", () => {
    for (const env of ["production", "development", "test"]) {
      const p = policy({ NODE_ENV: env, ALLOW_ACCOUNT_HARD_DELETE: "false" });
      expect(p.enabled).toBe(false);
      expect(() => p.assertAllowed()).toThrow(ForbiddenException);
    }
  });

  it("mayúsculas y minúsculas dan lo mismo", () => {
    expect(policy({ ALLOW_ACCOUNT_HARD_DELETE: "FALSE" }).enabled).toBe(false);
    expect(policy({ ALLOW_ACCOUNT_HARD_DELETE: "False" }).enabled).toBe(false);
  });

  it("cualquier otro valor no apaga nada: solo 'false' apaga", () => {
    expect(policy({ ALLOW_ACCOUNT_HARD_DELETE: "true" }).enabled).toBe(true);
    expect(policy({ ALLOW_ACCOUNT_HARD_DELETE: "quizás" }).enabled).toBe(true);
    expect(policy({ ALLOW_ACCOUNT_HARD_DELETE: "" }).enabled).toBe(true);
    expect(policy({ ALLOW_ACCOUNT_HARD_DELETE: "0" }).enabled).toBe(true);
  });

  it("cuando está apagado, el 403 dice qué hacer en su lugar", () => {
    expect(() =>
      policy({ ALLOW_ACCOUNT_HARD_DELETE: "false" }).assertAllowed(),
    ).toThrow(/suspenden o se dan de baja/);
  });

  it("cuando está habilitado, assertAllowed no corta nada", () => {
    expect(() =>
      policy({ NODE_ENV: "production" }).assertAllowed(),
    ).not.toThrow();
  });
});
