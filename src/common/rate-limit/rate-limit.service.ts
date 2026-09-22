import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Contador persistente de pedidos (tabla RateLimitBucket).
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Segundos hasta que se pueda volver a intentar, si no se permitió. */
  retryAfterSec: number;
  remaining: number;
}

/** Lo que devuelve el upsert: ya decidido del lado de la base. */
export interface FilaDelContador {
  count: number;
  blocked: boolean;
  retryAfterSec: number;
}

/**
 * Hasta cuánto se guarda de una clave.
 *
 * Las claves las armamos nosotros ("auth.login:ip:1.2.3.4"), pero una parte
 * sale de una cabecera: detrás de un proxy mal configurado alguien podría
 * mandar una "IP" de diez mil caracteres y dejarla guardada en una fila por
 * cada pedido. Doscientos alcanzan de sobra para un nombre, una IPv6 y un uuid.
 */
const LARGO_MAXIMO_DE_CLAVE = 200;

/**
 * EL LÍMITE DE PEDIDOS QUE NO SE REINICIA CON CADA INSTANCIA.
 *
 * El limitador de Nest cuenta en memoria, y en serverless cada instancia nueva
 * arranca en cero: alguien que reparte sus intentos entre instancias —o que
 * simplemente espera a que Vercel levante una nueva— no se topa nunca con el
 * tope. Para las rutas donde un tope es la defensa (login, códigos, pagos) el
 * contador vive en la base y lo ven todas las instancias a la vez.
 *
 * ── Por qué una sola sentencia ──────────────────────────────────────────────
 * Leer el contador, decidir y escribir en tres pasos deja una carrera: veinte
 * pedidos simultáneos leen todos "count = 3", todos deciden que pasan y todos
 * escriben "4". Un atacante con paralelismo convierte un tope de 10 en uno de
 * 10 × concurrencia. El INSERT … ON CONFLICT DO UPDATE toma el lock de la fila
 * y decide ADENTRO de la base, así que cada pedido ve el contador que dejó el
 * anterior, sin importar cuántos lleguen juntos.
 *
 * ── Qué hace, pedido por pedido ─────────────────────────────────────────────
 *   · clave nueva                    → count 1, ventana que arranca ahora
 *   · bloqueada (blockedUntil futuro) → no cuenta ni extiende: sigue bloqueada
 *   · ventana vencida o bloqueo ya cumplido → se reinicia en 1
 *   · si no, count + 1; al pasar el límite, queda bloqueada `blockSec`
 *
 * Un pedido bloqueado NO extiende el bloqueo a propósito: si cada intento lo
 * estirara, una persona real que sigue apretando el botón no saldría nunca, y
 * el atacante no pierde nada por esperar.
 *
 * ── La hora es la de la base ────────────────────────────────────────────────
 * `NOW() AT TIME ZONE 'UTC'` y no un Date armado acá. Con varias instancias,
 * cada una con su reloj, una ventana calculada con la hora de cada una se
 * corre para un lado o para el otro según a cuál le toque el pedido. La base es
 * una sola. Va en UTC porque las columnas son `timestamp` sin zona y Prisma
 * las escribe en UTC: comparar contra la hora local de la sesión correría
 * todas las ventanas por el huso horario del servidor.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * SI ESTE CONTADOR ESTÁ APAGADO.
   *
   * En la suite de pruebas todos los pedidos salen de 127.0.0.1 y comparten la
   * misma base, así que un tope de "5 registros cada 15 minutos por IP" —que es
   * exactamente lo que queremos en producción— frena la segunda prueba que
   * registra a alguien. Por eso bajo NODE_ENV=test arranca apagado, y una
   * prueba que quiera comprobar el límite lo enciende con RATE_LIMIT_ENFORCE.
   *
   * En producción NO se puede apagar, ni por error ni a propósito: la variable
   * ni se mira. Un interruptor para desactivar el límite de intentos es
   * exactamente lo que alguien que entró al panel buscaría primero.
   */
  private apagado(): boolean {
    if (process.env.NODE_ENV === "production") return false;
    if (process.env.RATE_LIMIT_ENFORCE === "true") return false;
    return process.env.NODE_ENV === "test";
  }

  /** Borra los contadores. Solo para las pruebas: en producción no se usa. */
  async reset(): Promise<void> {
    if (process.env.NODE_ENV === "production") return;
    await this.prisma.rateLimitBucket.deleteMany();
  }

  async hit(
    key: string,
    limit: number,
    windowSec: number,
    blockSec?: number,
  ): Promise<RateLimitResult> {
    if (this.apagado()) {
      return { allowed: true, retryAfterSec: 0, remaining: limit };
    }

    const clave = key.slice(0, LARGO_MAXIMO_DE_CLAVE);
    const tope = Math.max(0, Math.floor(limit));
    const ventanaSeg = Math.max(1, Math.ceil(windowSec));
    const bloqueoSeg = Math.max(1, Math.ceil(blockSec ?? windowSec));

    const ahora = Prisma.sql`(NOW() AT TIME ZONE 'UTC')`;
    const ventana = Prisma.sql`(${ventanaSeg}::int * INTERVAL '1 second')`;
    const bloqueo = Prisma.sql`(${bloqueoSeg}::int * INTERVAL '1 second')`;
    // Dentro de DO UPDATE, `b` es la fila COMO ESTABA: todas las ramas miran
    // el mismo estado anterior, y por eso se pueden decidir por separado sin
    // que una vea lo que escribió la otra.
    const bloqueada = Prisma.sql`b."blockedUntil" > ${ahora}`;
    const reinicia = Prisma.sql`(b."blockedUntil" IS NOT NULL OR b."windowStartedAt" + ${ventana} <= ${ahora})`;

    try {
      const filas = await this.prisma.$queryRaw<FilaDelContador[]>`
        INSERT INTO "RateLimitBucket" AS b
          ("key", "count", "windowStartedAt", "blockedUntil", "updatedAt")
        VALUES (
          ${clave},
          1,
          ${ahora},
          CASE WHEN 1 > ${tope}::int THEN ${ahora} + ${bloqueo} ELSE NULL END,
          ${ahora}
        )
        ON CONFLICT ("key") DO UPDATE SET
          "count" = CASE
            WHEN ${bloqueada} THEN b."count"
            WHEN ${reinicia} THEN 1
            ELSE b."count" + 1
          END,
          "windowStartedAt" = CASE
            WHEN ${bloqueada} THEN b."windowStartedAt"
            WHEN ${reinicia} THEN ${ahora}
            ELSE b."windowStartedAt"
          END,
          "blockedUntil" = CASE
            WHEN ${bloqueada} THEN b."blockedUntil"
            WHEN ${reinicia} THEN
              CASE WHEN 1 > ${tope}::int THEN ${ahora} + ${bloqueo} ELSE NULL END
            WHEN b."count" + 1 > ${tope}::int THEN ${ahora} + ${bloqueo}
            ELSE NULL
          END,
          "updatedAt" = ${ahora}
        RETURNING
          b."count" AS "count",
          (b."blockedUntil" IS NOT NULL AND b."blockedUntil" > ${ahora}) AS "blocked",
          CASE
            WHEN b."blockedUntil" IS NOT NULL AND b."blockedUntil" > ${ahora}
              THEN CEIL(EXTRACT(EPOCH FROM (b."blockedUntil" - ${ahora})))::int
            ELSE 0
          END AS "retryAfterSec"
      `;

      const fila = filas[0];
      if (!fila) {
        // Un upsert con RETURNING devuelve siempre una fila. Si no volvió
        // ninguna, algo raro pasó en el camino y se trata como un error de
        // base: se deja pasar, por lo mismo que abajo.
        this.logger.error(
          `El contador ${clave} no devolvió fila: se deja pasar el pedido`,
        );
        return this.permitido(tope);
      }

      return interpretar(fila, tope);
    } catch (error) {
      // SE FALLA ABIERTO, y es una decisión.
      //
      // Si la base tiene un hipo, fallar cerrado dejaría a TODO EL MUNDO
      // afuera del login —y de cada ruta con este límite— por un problema que
      // no es de nadie que esté pidiendo. El limitador en memoria de Nest
      // sigue corriendo delante de este, así que un pedido que pasa acá no
      // pasa sin ningún tope: pasa con el de la instancia. Y si la base de
      // verdad está caída, el login no anda igual, porque tampoco puede leer
      // la cuenta: cerrar acá no protege nada que no esté cerrado ya.
      const detalle = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `No se pudo consultar el contador ${clave} (${detalle}): se deja pasar el pedido`,
      );
      return this.permitido(tope);
    }
  }

  private permitido(tope: number): RateLimitResult {
    return { allowed: true, retryAfterSec: 0, remaining: tope };
  }
}

/**
 * La fila que devolvió la base, como resultado.
 *
 * Exportada solo para las pruebas: la decisión la toma el SQL, y esto es la
 * traducción, pero es justo la parte que se puede fijar sin una base.
 */
export function interpretar(
  fila: FilaDelContador,
  tope: number,
): RateLimitResult {
  const bloqueada = fila.blocked === true;
  return {
    allowed: !bloqueada,
    // Nunca 0 si está bloqueada: un Retry-After de 0 le dice al cliente que
    // reintente ya, y reintentar ya es exactamente lo que no tiene que hacer.
    retryAfterSec: bloqueada ? Math.max(1, Number(fila.retryAfterSec) || 0) : 0,
    remaining: Math.max(0, tope - Number(fila.count)),
  };
}
