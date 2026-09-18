import { UserRole, UserStatus } from "@prisma/client";
import { AdminBootstrapService } from "./admin-bootstrap.service";

/**
 * Cómo llega a haber un primer administrador.
 *
 * Lo que cuida este archivo son las dos cosas que hacen que esto sea una
 * herramienta de arranque y no una puerta trasera: que sin la variable no pase
 * NADA, y que la variable solo pueda DAR el rol, nunca sacarlo.
 */
function crear(
  env: Record<string, string>,
  usuarios: { id: string; email: string; role?: UserRole }[],
) {
  const promovidos: string[] = [];
  const auditados: unknown[] = [];

  const prisma = {
    user: {
      findMany: ({ where }: { where: { email: { in: string[] } } }) =>
        Promise.resolve(
          usuarios
            .filter(
              (u) =>
                where.email.in.includes(u.email) &&
                (u.role ?? UserRole.USER) !== UserRole.ADMIN,
            )
            .map((u) => ({ id: u.id, email: u.email })),
        ),
      count: () =>
        Promise.resolve(
          usuarios.filter((u) => u.role === UserRole.ADMIN).length,
        ),
      update: ({ where }: { where: { id: string } }) => {
        promovidos.push(where.id);
        return Promise.resolve({});
      },
    },
  };
  const config = { get: (clave: string) => env[clave] };
  const auditLog = {
    create: (entrada: unknown) => {
      auditados.push(entrada);
      return Promise.resolve();
    },
  };

  const service = new AdminBootstrapService(
    prisma as never,
    config as never,
    auditLog as never,
  );
  return { service, promovidos, auditados };
}

const ACTIVA = { id: "u1", email: "persona@ejemplo.test" };

describe("AdminBootstrapService", () => {
  it("sin la variable no promueve a nadie", async () => {
    // Es la protección de fondo: un deploy que no la defina no tiene ningún
    // administrador automático. Lo seguro es el estado por omisión.
    const { service, promovidos } = crear({}, [ACTIVA]);
    expect(await service.sync()).toEqual([]);
    expect(promovidos).toEqual([]);
  });

  it("promueve la cuenta que la variable nombra", async () => {
    const { service, promovidos } = crear(
      { ADMIN_EMAILS: "persona@ejemplo.test" },
      [ACTIVA],
    );
    expect(await service.sync()).toEqual(["persona@ejemplo.test"]);
    expect(promovidos).toEqual(["u1"]);
  });

  it("acepta varias, separadas por coma, espacio o punto y coma", () => {
    const { service } = crear(
      {
        ADMIN_EMAILS:
          " UNA@Ejemplo.test , otra@ejemplo.test; tercera@ejemplo.test ",
      },
      [],
    );
    expect(service.configuredEmails()).toEqual([
      "una@ejemplo.test",
      "otra@ejemplo.test",
      "tercera@ejemplo.test",
    ]);
  });

  it("normaliza el mail: la variable la escribe una persona en un panel", async () => {
    // Un espacio pegado al pegar el mail, o una mayúscula, no pueden ser la
    // diferencia entre que esto funcione y no.
    const { service, promovidos } = crear(
      { ADMIN_EMAILS: "  Persona@Ejemplo.TEST  " },
      [ACTIVA],
    );
    await service.sync();
    expect(promovidos).toEqual(["u1"]);
  });

  it("NO le saca el rol a nadie que la variable no nombre", async () => {
    // Sacar el rol es una decisión que se toma en el panel, con su registro de
    // auditoría. Que dependa de editar una variable de entorno significaría
    // que un error de tipeo deja la plataforma sin administradores.
    const { service, promovidos } = crear(
      { ADMIN_EMAILS: "persona@ejemplo.test" },
      [ACTIVA, { id: "u2", email: "otro@ejemplo.test", role: UserRole.ADMIN }],
    );
    await service.sync();
    expect(promovidos).toEqual(["u1"]);
  });

  it("deja el cambio de rol en el registro de auditoría", async () => {
    const { service, auditados } = crear(
      { ADMIN_EMAILS: "persona@ejemplo.test" },
      [ACTIVA],
    );
    await service.sync();
    expect(auditados).toHaveLength(1);
    expect(auditados[0]).toMatchObject({
      action: "admin.user.role.bootstrap",
      entityId: "u1",
      metadata: { role: UserRole.ADMIN, source: "ADMIN_EMAILS" },
    });
  });

  it("un fallo de base no tira abajo el arranque del servidor", async () => {
    // Que el panel quede sin administrador es un problema; que la API entera
    // no levante por eso es peor.
    const prisma = {
      user: {
        findMany: () => Promise.reject(new Error("base caída")),
        count: () => Promise.resolve(0),
        update: () => Promise.resolve({}),
      },
    };
    const service = new AdminBootstrapService(
      prisma as never,
      { get: () => "persona@ejemplo.test" } as never,
      { create: () => Promise.resolve() } as never,
    );
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it("ignora cuentas borradas o suspendidas", async () => {
    // El filtro vive en la consulta (status in ACTIVE/PENDING_VERIFICATION);
    // acá se comprueba que la consulta lo pida, que es lo que se puede romper
    // sin que nada más se entere.
    let filtro: unknown;
    const prisma = {
      user: {
        findMany: (args: { where: unknown }) => {
          filtro = args.where;
          return Promise.resolve([]);
        },
        count: () => Promise.resolve(1),
        update: () => Promise.resolve({}),
      },
    };
    const service = new AdminBootstrapService(
      prisma as never,
      { get: () => "persona@ejemplo.test" } as never,
      { create: () => Promise.resolve() } as never,
    );
    await service.sync();
    expect(filtro).toMatchObject({
      status: { in: [UserStatus.ACTIVE, UserStatus.PENDING_VERIFICATION] },
    });
  });
});
