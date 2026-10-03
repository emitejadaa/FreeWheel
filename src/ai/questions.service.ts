import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * LAS PREGUNTAS MÁS HECHAS AL ASISTENTE, DE TODO EL SITIO.
 *
 * El asistente ofrece cuatro preguntas sugeridas en botones. El front ya las
 * acomoda a lo que viene preguntando cada persona, contando en su propio
 * navegador, pero eso no es lo que se buscaba: lo útil es saber qué le pregunta
 * la gente AL SITIO. Esa cuenta no puede vivir en un navegador.
 *
 * Son dos operaciones y las dos son chicas: sumar uno, y leer el ranking.
 *
 * ── QUÉ SE GUARDA ─────────────────────────────────────────────────────────
 *
 * El identificador de la pregunta y un número. NO quién preguntó, NO cuándo lo
 * hizo cada uno, NO el texto que escribió. Alcanza para ordenar cuatro botones,
 * que es todo lo que se quiere. Guardar más sería armar un registro de lo que
 * cada persona le pregunta al asistente —dudas sobre plata, sobre daños, sobre
 * documentos— para decidir el orden de cuatro botones.
 *
 * ── LA LISTA DE IDS ESTÁ ESCRITA DOS VECES, Y ES A PROPÓSITO ──────────────
 *
 * El vocabulario de preguntas lo define el front, en src/data/preguntasWili.js.
 * Pero la ruta que suma es PÚBLICA, porque el asistente contesta también a
 * visitantes sin cuenta, y una ruta pública que escribe la fila que le pidan es
 * una tabla que se llena de basura con un rizo de curl. Así que acá hay una
 * copia de los ids permitidos y lo que no está en la lista se descarta sin
 * tocar la base.
 *
 * SI SE AGREGA UNA PREGUNTA EN EL FRONT, HAY QUE AGREGARLA ACÁ. Si no, se
 * contesta igual (el front no depende de esto para responder) pero no se cuenta.
 *
 * ── Y SI LA TABLA NO EXISTE, NO PASA NADA ─────────────────────────────────
 *
 * La migración de este cambio puede tardar en aplicarse en el deploy, que no lo
 * maneja quien escribe esto. Mientras no esté, Prisma tira error de tabla
 * inexistente. Acá se atrapa y se sigue: sumar no hace nada y el ranking vuelve
 * vacío, que es exactamente lo que el front ya sabe manejar —se queda con la
 * cuenta de su propio navegador—. Lo que NO puede pasar es que el asistente deje
 * de contestar porque un contador de botones no tiene dónde escribir.
 */
@Injectable()
export class QuestionsService {
  private readonly log = new Logger(QuestionsService.name);

  /**
   * Los ids que se aceptan. Copia de src/data/preguntasWili.js del front.
   *
   * Es una lista corta y cerrada a propósito: las preguntas con respuesta
   * propia son las únicas que pueden ir en un botón, así que son las únicas que
   * tiene sentido contar. Contar lo que la gente escribe suelto llenaría el
   * ranking de "hola" y de preguntas que no sabemos contestar, que es justo lo
   * que no puede ocupar un botón.
   */
  static readonly PERMITIDAS = [
    "warranty",
    "accident",
    "cancel",
    "documents",
    "publish",
    "payments",
    "delivery",
    "verify",
  ] as const;

  /**
   * Cuántas veces hace falta que se pregunte algo para que entre en el ranking.
   *
   * Con una vez, la primera persona que toca un botón decide el orden de los
   * botones para todos los demás. Y en una demostración eso es peor todavía:
   * alcanza con que alguien pruebe el asistente adelante de la clase para que
   * esa pregunta quede primera. Tres es poco, pero ya no es una sola persona.
   */
  static readonly MINIMO_PARA_EL_RANKING = 3;

  constructor(private readonly prisma: PrismaService) {}

  /** ¿Es uno de los ids que el front sabe contestar? */
  static permitida(questionId: unknown): boolean {
    return (
      typeof questionId === "string" &&
      (QuestionsService.PERMITIDAS as readonly string[]).includes(questionId)
    );
  }

  /**
   * Suma uno a una pregunta.
   *
   * Devuelve `{ contada }` y nunca lanza: el front llama a esto DESPUÉS de haber
   * contestado, así que un error acá no tiene a quién avisarle y no debería
   * ensuciar la respuesta de nada.
   */
  async contar(questionId: string): Promise<{ contada: boolean }> {
    if (!QuestionsService.permitida(questionId)) return { contada: false };
    try {
      // upsert y no update: la primera vez que alguien pregunta algo, la fila
      // todavía no existe. El increment lo hace la base, así que dos personas
      // preguntando a la vez suman dos y no una.
      await this.prisma.assistantQuestionCount.upsert({
        where: { questionId },
        create: { questionId, count: 1 },
        update: { count: { increment: 1 } },
      });
      return { contada: true };
    } catch (error) {
      this.log.warn(
        `No se pudo contar la pregunta "${questionId}": ${this.porQue(error)}`,
      );
      return { contada: false };
    }
  }

  /**
   * El ranking, de la más preguntada a la menos.
   *
   * Solo las que llegaron al mínimo. Si la tabla todavía no existe, o la
   * consulta falla, vuelve vacío: el front se queda con la cuenta de su propio
   * navegador y los botones siguen funcionando igual.
   */
  async ranking(): Promise<{
    preguntas: { questionId: string; count: number }[];
    minimo: number;
  }> {
    const minimo = QuestionsService.MINIMO_PARA_EL_RANKING;
    try {
      const filas = await this.prisma.assistantQuestionCount.findMany({
        where: { count: { gte: minimo } },
        orderBy: [{ count: "desc" }, { questionId: "asc" }],
        select: { questionId: true, count: true },
        take: QuestionsService.PERMITIDAS.length,
      });
      // Una pregunta que se sacó del front puede haber quedado contada. Se
      // filtra al leer para que no vuelva a aparecer en un botón que ya no
      // tiene respuesta.
      return {
        preguntas: filas.filter((f) =>
          QuestionsService.permitida(f.questionId),
        ),
        minimo,
      };
    } catch (error) {
      this.log.warn(`No se pudo leer el ranking: ${this.porQue(error)}`);
      return { preguntas: [], minimo };
    }
  }

  /**
   * El motivo, corto, para el log.
   *
   * El caso esperado mientras la migración no esté aplicada es el P2021 de
   * Prisma ("la tabla no existe"), y conviene que el log lo diga con esas
   * palabras: es un paso que falta, no algo roto.
   */
  private porQue(error: unknown): string {
    const codigo = (error as { code?: string })?.code;
    if (codigo === "P2021") {
      return "la tabla AssistantQuestionCount todavía no existe (falta aplicar la migración)";
    }
    return codigo ?? (error as Error)?.message ?? "error desconocido";
  }
}
