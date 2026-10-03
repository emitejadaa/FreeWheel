import { QuestionsService } from "./questions.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * EL CONTADOR DE PREGUNTAS SUGERIDAS
 *
 * Son cuatro cosas, y tres de ellas son sobre qué pasa cuando algo no está como
 * debería:
 *
 *  1) LO QUE NO ESTÁ EN LA LISTA NO TOCA LA BASE. La ruta que suma es pública,
 *     porque el asistente contesta también a visitantes sin cuenta. Una ruta
 *     pública que escribe la fila que le pidan es una tabla que se llena de
 *     basura con un rizo de curl, y encima con filas que después aparecerían
 *     como botones que no sabemos contestar.
 *
 *  2) SI LA TABLA NO EXISTE, EL ASISTENTE SIGUE ANDANDO. La migración de este
 *     cambio puede tardar en aplicarse en el deploy. Mientras no esté, Prisma
 *     tira P2021. Un contador de botones que no tiene dónde escribir no puede
 *     dejar al asistente sin contestar.
 *
 *  3) EL MÍNIMO. Con una sola vez, la primera persona que toca un botón decide
 *     el orden para todos los demás. En una demostración es peor: alcanza con
 *     que alguien pruebe el asistente adelante de la clase.
 *
 *  4) Y que el ranking venga ordenado, que es lo único que se le pide.
 */
describe("QuestionsService — las preguntas más hechas al asistente", () => {
  type Fila = { questionId: string; count: number };

  /**
   * El error que tira Prisma, con el `code` adentro.
   *
   * Es un Error de verdad y no un objeto suelto porque es lo que Prisma tira, y
   * el servicio lee `.code` y `.message`: si acá se tirara otra cosa, la prueba
   * no probaría el camino real.
   */
  class FallaDePrisma extends Error {
    constructor(
      message: string,
      readonly code?: string,
    ) {
      super(message);
    }
  }

  let filas: Fila[];
  let service: QuestionsService;
  let falla: FallaDePrisma | null;
  let escrituras: number;

  /** Un Prisma de juguete con lo poco que este servicio usa. */
  const prismaFalso = () =>
    ({
      assistantQuestionCount: {
        upsert: ({
          where,
          update,
        }: {
          where: { questionId: string };
          create: Fila;
          update: { count: { increment: number } };
        }) => {
          if (falla) return Promise.reject(falla);
          escrituras += 1;
          const fila = filas.find((f) => f.questionId === where.questionId);
          if (fila) fila.count += update.count.increment;
          else filas.push({ questionId: where.questionId, count: 1 });
          return Promise.resolve(fila ?? filas[filas.length - 1]);
        },
        findMany: ({ where }: { where: { count: { gte: number } } }) => {
          if (falla) return Promise.reject(falla);
          return Promise.resolve(
            filas
              .filter((f) => f.count >= where.count.gte)
              .sort(
                (a, b) =>
                  b.count - a.count || a.questionId.localeCompare(b.questionId),
              )
              .map((f) => ({ questionId: f.questionId, count: f.count })),
          );
        },
      },
    }) as unknown as PrismaService;

  beforeEach(() => {
    filas = [];
    falla = null;
    escrituras = 0;
    service = new QuestionsService(prismaFalso());
    // El log de los casos de error no tiene por qué ensuciar la salida de las
    // pruebas: lo que se prueba es que NO lanza, no que escribe un aviso.
    jest.spyOn(service["log"], "warn").mockImplementation(() => undefined);
  });

  // ── La lista cerrada ─────────────────────────────────────────────────────

  it("acepta las preguntas que el front sabe contestar", async () => {
    for (const id of QuestionsService.PERMITIDAS) {
      expect(QuestionsService.permitida(id)).toBe(true);
      await expect(service.contar(id)).resolves.toEqual({ contada: true });
    }
    expect(escrituras).toBe(QuestionsService.PERMITIDAS.length);
  });

  it("LO QUE NO ESTÁ EN LA LISTA NO LLEGA A LA BASE", async () => {
    const basura = [
      "inventada",
      "",
      "warranty; DROP TABLE",
      "WARRANTY",
      "../../etc/passwd",
    ];
    for (const id of basura) {
      await expect(service.contar(id)).resolves.toEqual({ contada: false });
    }
    expect(escrituras).toBe(0);
    expect(filas).toEqual([]);
  });

  it("tampoco un id que no es un texto", async () => {
    for (const raro of [null, undefined, 7, {}, ["warranty"]]) {
      expect(QuestionsService.permitida(raro)).toBe(false);
      await expect(service.contar(raro as unknown as string)).resolves.toEqual({
        contada: false,
      });
    }
    expect(escrituras).toBe(0);
  });

  // ── Sumar ────────────────────────────────────────────────────────────────

  it("suma de a uno, y la primera vez crea la fila", async () => {
    await service.contar("cancel");
    expect(filas).toEqual([{ questionId: "cancel", count: 1 }]);
    await service.contar("cancel");
    await service.contar("cancel");
    expect(filas).toEqual([{ questionId: "cancel", count: 3 }]);
  });

  it("cada pregunta tiene su propia fila", async () => {
    await service.contar("cancel");
    await service.contar("warranty");
    expect(filas).toHaveLength(2);
  });

  // ── El ranking ───────────────────────────────────────────────────────────

  it("el ranking sale de la más preguntada a la menos", async () => {
    filas = [
      { questionId: "cancel", count: 4 },
      { questionId: "delivery", count: 9 },
      { questionId: "warranty", count: 6 },
    ];
    const { preguntas } = await service.ranking();
    expect(preguntas.map((p) => p.questionId)).toEqual([
      "delivery",
      "warranty",
      "cancel",
    ]);
  });

  it("un empate se resuelve igual siempre, no al azar", async () => {
    filas = [
      { questionId: "warranty", count: 5 },
      { questionId: "cancel", count: 5 },
    ];
    const primera = await service.ranking();
    const segunda = await service.ranking();
    expect(primera.preguntas).toEqual(segunda.preguntas);
  });

  it("ABAJO DEL MÍNIMO NO ENTRA AL RANKING", async () => {
    // Una persona tocando un botón no decide el orden de los botones de todos,
    // y en una demostración eso es lo que pasaría.
    const minimo = QuestionsService.MINIMO_PARA_EL_RANKING;
    filas = [
      { questionId: "cancel", count: minimo - 1 },
      { questionId: "warranty", count: minimo },
    ];
    const { preguntas, minimo: devuelto } = await service.ranking();
    expect(preguntas.map((p) => p.questionId)).toEqual(["warranty"]);
    expect(devuelto).toBe(minimo);
  });

  it("una pregunta que ya no existe en el front se filtra al leer", async () => {
    // Quedó contada de antes y no tiene respuesta: en un botón sería una
    // pregunta que al tocarla no sabemos contestar.
    filas = [
      { questionId: "preguntaVieja", count: 50 },
      { questionId: "cancel", count: 4 },
    ];
    const { preguntas } = await service.ranking();
    expect(preguntas.map((p) => p.questionId)).toEqual(["cancel"]);
  });

  it("sin nada contado el ranking está vacío, y eso no es un error", async () => {
    await expect(service.ranking()).resolves.toEqual({
      preguntas: [],
      minimo: QuestionsService.MINIMO_PARA_EL_RANKING,
    });
  });

  // ── Cuando la base no está ───────────────────────────────────────────────

  it("SI LA TABLA NO EXISTE, NO LANZA NI ROMPE EL ASISTENTE", async () => {
    falla = new FallaDePrisma("table does not exist", "P2021");
    await expect(service.contar("cancel")).resolves.toEqual({
      contada: false,
    });
    await expect(service.ranking()).resolves.toEqual({
      preguntas: [],
      minimo: QuestionsService.MINIMO_PARA_EL_RANKING,
    });
  });

  it("y con cualquier otra falla de la base, tampoco", async () => {
    falla = new FallaDePrisma("se cayó la conexión");
    await expect(service.contar("cancel")).resolves.toEqual({
      contada: false,
    });
    await expect(service.ranking()).resolves.toEqual({
      preguntas: [],
      minimo: QuestionsService.MINIMO_PARA_EL_RANKING,
    });
  });

  it("el log distingue la migración que falta de una base rota", async () => {
    const avisos: string[] = [];
    jest
      .spyOn(service["log"], "warn")
      .mockImplementation((mensaje: unknown) => {
        avisos.push(String(mensaje));
      });

    falla = new FallaDePrisma("table does not exist", "P2021");
    await service.contar("cancel");
    expect(avisos[0]).toContain("falta aplicar la migración");

    falla = new FallaDePrisma("se cayó la conexión");
    await service.contar("cancel");
    expect(avisos[1]).toContain("se cayó la conexión");
  });
});
