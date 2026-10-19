import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserRole, UserStatus } from "@prisma/client";
import { AuditLogService } from "../common/services/audit-log.service";
import { PrismaService } from "../prisma/prisma.service";
import { AntifraudeService } from "./antifraude.service";
import { CRUCES_PARA_SUSPENDER, RESENAS_POR_DIA } from "./limites";

/**
 * EL GUARDIÁN, CONTRA LA BASE
 *
 * La política se prueba sola en limites.spec.ts, con números a mano. Acá se
 * prueba lo otro, que es donde los errores no se ven leyendo: que los datos que
 * se le pasan a esa política sean los correctos.
 *
 * Y una cosa en particular, que es la que puede arruinar todo: que las reseñas
 * se cuenten CON SU DIRECCIÓN. Si "le escribí" y "me escribió" se mezclaran, un
 * cliente fiel que alquila el mismo auto todos los meses se vería igual que un
 * circuito, y el sistema terminaría suspendiendo justo a quien lo usa bien.
 */
describe("AntifraudeService", () => {
  const AHORA = new Date("2026-06-15T12:00:00.000Z");
  const haceHoras = (h: number) =>
    new Date(AHORA.getTime() - h * 60 * 60 * 1000);
  const haceDias = (d: number) => haceHoras(d * 24);

  /*
    EL RELOJ, CONGELADO.

    Los topes y las ventanas los calcula el servicio con `new Date()`, no con
    una fecha que entre por parámetro: en producción eso es correcto —nadie le
    pasa la hora a un control de seguridad—, pero deja a las pruebas atadas al
    reloj de la máquina. Sin congelarlo, los datos de ejemplo quedan meses en el
    pasado y ninguna ventana los alcanza, así que todo "pasa" sin probar nada.
  */
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(AHORA);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /** La forma de las consultas que hace el servicio, para tipar los mocks. */
  interface ConsultaConFecha {
    where: { authorId?: string; createdAt?: { gte?: Date } };
  }

  function armar({
    rol = UserRole.USER as UserRole,
    email = "persona@test.com",
    status = UserStatus.ACTIVE as UserStatus,
    creada = haceDias(300),
    escritas = [] as { targetUserId: string; createdAt: Date }[],
    recibidas = [] as { authorId: string; createdAt: Date }[],
    publicaciones = [] as { createdAt: Date }[],
    abiertas = [] as { kind: string }[],
    exentosExtra = "",
  } = {}) {
    const usuario = { email, role: rol, status, createdAt: creada };
    const creadas: { kind: string; autoSuspended: boolean }[] = [];
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(usuario),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Partial<typeof usuario> }) => {
            Object.assign(usuario, data);
            return usuario;
          }),
      },
      review: {
        findMany: jest.fn().mockImplementation((args: ConsultaConFecha) => {
          // La consulta de escritas filtra por authorId; la de recibidas, por
          // targetUserId. Se distinguen por ahí, como en el servicio.
          if (args.where.authorId) {
            const desde = args.where.createdAt?.gte;
            return escritas.filter((r) => !desde || r.createdAt >= desde);
          }
          return recibidas;
        }),
      },
      listing: {
        findMany: jest.fn().mockImplementation((args: ConsultaConFecha) => {
          const desde = args.where.createdAt?.gte;
          return publicaciones.filter((p) => !desde || p.createdAt >= desde);
        }),
      },
      fraudSignal: {
        findMany: jest.fn().mockResolvedValue(abiertas),
        createMany: jest
          .fn()
          .mockImplementation(
            ({
              data,
            }: {
              data: { kind: string; autoSuspended: boolean }[];
            }) => {
              creadas.push(...data);
              return { count: data.length };
            },
          ),
      },
    };
    const auditLog = { create: jest.fn() };
    const service = new AntifraudeService(
      prisma as unknown as PrismaService,
      auditLog as unknown as AuditLogService,
      { get: () => exentosExtra } as unknown as ConfigService,
    );
    return { service, prisma, auditLog, usuario, creadas };
  }

  // ── Los datos que se le pasan a la política ─────────────────────────────

  describe("qué cuenta de cada cuenta", () => {
    it("separa las de hoy, las de la semana y las de la ventana", async () => {
      const { service } = armar({
        escritas: [
          { targetUserId: "a", createdAt: haceHoras(2) },
          { targetUserId: "b", createdAt: haceHoras(10) },
          { targetUserId: "c", createdAt: haceDias(3) },
        ],
      });
      const actividad = await service.actividadDe("yo", AHORA);
      expect(actividad.resenasEscritasHoy).toBe(2);
      expect(actividad.resenasEscritasEnLaSemana).toBe(3);
    });

    it("CUENTA LAS RESEÑAS CON SU DIRECCIÓN", async () => {
      /*
        Lo que define un circuito es que vaya en las DOS direcciones. Acá "yo"
        le escribió tres veces a `fiel` y no recibió ninguna de vuelta: es
        alguien que alquila seguido el mismo auto, no un anillo.
      */
      const { service } = armar({
        escritas: [
          { targetUserId: "fiel", createdAt: haceDias(1) },
          { targetUserId: "fiel", createdAt: haceDias(2) },
          { targetUserId: "fiel", createdAt: haceDias(3) },
        ],
        recibidas: [{ authorId: "otra", createdAt: haceDias(5) }],
      });
      const actividad = await service.actividadDe("yo", AHORA);
      expect(actividad.cruces).toEqual([
        { otroId: "fiel", escritas: 3, recibidas: 0 },
      ]);
    });

    it("y las cruza bien cuando SÍ van en las dos", async () => {
      const { service } = armar({
        escritas: [
          { targetUserId: "socio", createdAt: haceDias(1) },
          { targetUserId: "socio", createdAt: haceDias(2) },
        ],
        recibidas: [
          { authorId: "socio", createdAt: haceDias(1) },
          { authorId: "socio", createdAt: haceDias(2) },
          { authorId: "otra", createdAt: haceDias(4) },
        ],
      });
      const actividad = await service.actividadDe("yo", AHORA);
      expect(actividad.cruces).toEqual([
        { otroId: "socio", escritas: 2, recibidas: 2 },
      ]);
    });

    it("la concentración mira TODAS las recibidas, no solo las de la ventana", async () => {
      /*
        "Casi todo lo que tiene viene de dos cuentas" es una propiedad del
        perfil entero. Mirando treinta días, un perfil inflado hace seis meses
        se vería limpio, que es justo al revés de lo que se quiere.
      */
      const { service } = armar({
        recibidas: [
          ...Array.from({ length: 8 }, () => ({
            authorId: "amigo",
            createdAt: haceDias(200),
          })),
          { authorId: "otra", createdAt: haceDias(5) },
        ],
      });
      const actividad = await service.actividadDe("yo", AHORA);
      expect(actividad.recibidas).toBe(9);
      expect(actividad.recibidasDeLosDosQueMas).toBe(9);
    });

    it("y la antigüedad sale de cuándo se creó la cuenta", async () => {
      const { service } = armar({ creada: haceDias(3) });
      expect((await service.actividadDe("yo", AHORA)).diasDeAntiguedad).toBe(3);
    });
  });

  // ── Los topes ───────────────────────────────────────────────────────────

  describe("los topes", () => {
    it("cortan con un mensaje que dice cuándo se puede de nuevo", async () => {
      const { service } = armar({
        escritas: Array.from({ length: RESENAS_POR_DIA }, () => ({
          targetUserId: "x",
          createdAt: haceHoras(1),
        })),
      });
      await expect(service.assertPuedeResenar("yo")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("y dejan pasar a quien no llegó", async () => {
      const { service } = armar({
        escritas: [{ targetUserId: "x", createdAt: haceHoras(1) }],
      });
      await expect(service.assertPuedeResenar("yo")).resolves.toBeUndefined();
    });

    it("A LA CUENTA ADMINISTRADORA NO SE LE APLICAN", async () => {
      // Quien administra prueba el sistema: carga autos, cierra reservas a mano,
      // deja reseñas para ver cómo se ven. Esa es exactamente la forma que los
      // topes buscan.
      const { service } = armar({
        rol: UserRole.ADMIN,
        escritas: Array.from({ length: 50 }, () => ({
          targetUserId: "x",
          createdAt: haceHoras(1),
        })),
      });
      await expect(service.assertPuedeResenar("yo")).resolves.toBeUndefined();
      await expect(service.assertPuedePublicar("yo")).resolves.toBeUndefined();
    });
  });

  // ── La suspensión ───────────────────────────────────────────────────────

  describe("la suspensión automática", () => {
    /** Un circuito perfecto entre dos cuentas. */
    const anillo = () => ({
      escritas: Array.from({ length: CRUCES_PARA_SUSPENDER }, (_, i) => ({
        targetUserId: "socio",
        createdAt: haceDias(i + 1),
      })),
      recibidas: Array.from({ length: CRUCES_PARA_SUSPENDER }, (_, i) => ({
        authorId: "socio",
        createdAt: haceDias(i + 1),
      })),
    });

    it("CIERRA LA CUENTA ANTE UN ANILLO, sin esperar a nadie", async () => {
      const { service, usuario, creadas } = armar(anillo());
      const senales = await service.revisarDespuesDe("yo");

      expect(senales.map((s) => s.tipo)).toContain("ANILLO_DE_RESENAS");
      expect(usuario.status).toBe(UserStatus.SUSPENDED);
      expect(creadas[0]).toMatchObject({
        kind: "ANILLO_DE_RESENAS",
        autoSuspended: true,
      });
    });

    it("y queda escrito SIN ACTOR: no la cerró una persona", async () => {
      // La diferencia importa el día que alguien reclame: poner ahí al
      // administrador diría que él la suspendió.
      const { service, auditLog } = armar(anillo());
      await service.revisarDespuesDe("yo");
      const llamadas = auditLog.create.mock.calls as unknown[][];
      const linea = llamadas
        .map((l) => l[0] as { action: string; actorId?: string })
        .find((l) => l.action === "antifraude.cuenta_suspendida");
      expect(linea).toBeDefined();
      expect(linea?.actorId).toBeUndefined();
    });

    it("NO SUSPENDE POR PUBLICAR, por más autos que sean", async () => {
      const { service, usuario, creadas } = armar({
        publicaciones: Array.from({ length: 40 }, () => ({
          createdAt: haceHoras(1),
        })),
      });
      const senales = await service.revisarDespuesDe("yo");
      expect(senales.map((s) => s.tipo)).toContain("PUBLICACIONES_EN_RAFAGA");
      // La señal queda, pero la cuenta sigue abierta.
      expect(creadas.length).toBeGreaterThan(0);
      expect(usuario.status).toBe(UserStatus.ACTIVE);
    });

    it("ni suspende dos veces a la misma cuenta", async () => {
      const { service, prisma } = armar({
        ...anillo(),
        status: UserStatus.SUSPENDED,
      });
      await service.revisarDespuesDe("yo");
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("y a la cuenta exenta no le mira nada", async () => {
      const { service, usuario, creadas } = armar({
        ...anillo(),
        email: "demo01@freewheel.demo",
      });
      expect(await service.revisarDespuesDe("yo")).toEqual([]);
      expect(creadas).toEqual([]);
      expect(usuario.status).toBe(UserStatus.ACTIVE);
    });
  });

  describe("la bandeja del panel", () => {
    it("NO REPITE UNA SEÑAL QUE YA ESTÁ ABIERTA", async () => {
      /*
        Sin esto, cada reseña nueva de una cuenta marcada agregaría otra fila
        idéntica, y en dos días la bandeja serían cien avisos del mismo caso. El
        ruido tapa lo que importa, que es que haya un caso NUEVO.
      */
      const { service, creadas } = armar({
        publicaciones: Array.from({ length: 10 }, () => ({
          createdAt: haceHoras(1),
        })),
        abiertas: [{ kind: "PUBLICACIONES_EN_RAFAGA" }],
      });
      await service.revisarDespuesDe("yo");
      expect(creadas).toEqual([]);
    });
  });

  describe("cuando algo falla", () => {
    it("NO SE LLEVA PUESTA LA ACCIÓN QUE LO DISPARÓ", async () => {
      /*
        Esto corre con la reseña YA GUARDADA. Perder una reseña legítima porque
        el antifraude tuvo un mal momento sería cambiar un problema que nadie ve
        por uno que la persona sí ve.
      */
      const { service, prisma } = armar();
      prisma.review.findMany.mockRejectedValue(new Error("base caída"));
      await expect(service.revisarDespuesDe("yo")).resolves.toEqual([]);
    });
  });
});
