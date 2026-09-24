import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import type { Request, Response } from "express";

/**
 * QUÉ SE LE CUENTA AL CLIENTE CUANDO ALGO SALE MAL.
 *
 * ── POR QUÉ ESTO DEJÓ DE CONTESTAR SOLO "Internal server error" ───────────
 * Porque quien programa este front no puede abrir los logs del deploy: los
 * administra otra persona. Un 500 mudo significaba que la única forma de saber
 * qué pasó era pedirle a alguien que mirara Vercel, y mientras tanto no había
 * NADA sobre lo que trabajar: ni si era la base, ni una columna que falta, ni
 * un error del código.
 *
 * Es el mismo motivo por el que existen env-report.ts y processor-error.filter.ts,
 * y está dicho en sus encabezados.
 *
 * ── QUÉ SE DICE Y QUÉ NO ──────────────────────────────────────────────────
 * De los errores de la BASE se dice la clase de problema y, cuando lo hay, la
 * tabla o la columna que falta. Eso no es un secreto: los nombres de las tablas
 * están en el schema, que está en el repo. Y es exactamente el dato que
 * convierte "no anda nada" en "faltó correr la migración".
 *
 * De cualquier otro error inesperado NO se dice el mensaje. Ahí sí puede haber
 * detalle interno —una ruta de archivo, un fragmento de consulta— y nada
 * garantiza que sea presentable. Lo que se devuelve es un código corto y la
 * hora, que es lo que hace falta para encontrarlo en el log. Sigue siendo mucho
 * mejor que nada: quien lo reporta puede decir "me dio UNEXPECTED a las 18:42"
 * y eso encuentra la línea exacta.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const userId = (request.user as { id?: string } | undefined)?.id;
    // Method + path + user are safe to log; headers and body are intentionally
    // omitted because they may carry credentials, tokens, or passwords.
    const where = `${request.method} ${request.originalUrl}`;
    const who = userId ? ` user=${userId}` : "";

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const body =
        typeof payload === "string"
          ? { statusCode: status, message: payload }
          : payload;

      /*
        UN 5xx SOLO SE CUENTA ENTERO SI ALGUIEN LO ESCRIBIÓ PARA SER CONTADO.

        Los 503 previstos de este backend —PAYMENTS_NOT_CONFIGURED,
        ENCRYPTION_NOT_CONFIGURED— llevan un `code` puesto a mano y el front
        ramifica por él: recortarlos sería esconder justo lo que hay que
        mostrar.

        Un 5xx con el mensaje pelado es otra cosa: casi siempre es
        `new ServiceUnavailableException(error.message)`, o sea el mensaje de
        la causa envuelto, y ahí puede venir una consulta, una ruta del
        servidor o un pedazo de lo que se estaba procesando. Ese se recorta y
        se devuelve un identificador, igual que un error inesperado.
      */
      const escritoAMano =
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as { code?: unknown }).code === "string";

      if (
        status >= (HttpStatus.INTERNAL_SERVER_ERROR as number) &&
        !escritoAMano
      ) {
        const errorId = randomUUID();
        this.logger.error(
          `${where} -> ${status}${who} [${errorId}]: ${exception.message}`,
          exception.stack,
        );
        response.status(status).json({
          statusCode: status,
          code: "UNEXPECTED",
          message:
            "Algo falló del lado del servidor y no es un error previsto. " +
            "Quedó registrado: pasá este código para encontrarlo.",
          errorId,
          at: new Date().toISOString(),
        });
        return;
      }

      // Server errors are unexpected even when modeled as HttpException; log the
      // stack. Client errors (4xx) are routine, so warn without the stack.
      if (status >= (HttpStatus.INTERNAL_SERVER_ERROR as number)) {
        this.logger.error(
          `${where} -> ${status}${who}: ${exception.message}`,
          exception.stack,
        );
      } else {
        this.logger.warn(`${where} -> ${status}${who}: ${exception.message}`);
      }

      response.status(status).json(body);
      return;
    }

    const error = exception instanceof Error ? exception : undefined;

    const deLaBase = this.deLaBase(exception);
    if (deLaBase) {
      this.logger.error(
        `${where} -> ${deLaBase.statusCode}${who}: ${deLaBase.code} ${error?.message ?? ""}`,
        error?.stack,
      );
      response.status(deLaBase.statusCode).json(deLaBase);
      return;
    }

    /*
      El identificador y la hora van al log Y a la respuesta, y son el mismo
      par. Es lo que permite que alguien diga "me dio UNEXPECTED 9b1f…" y que
      esa línea se encuentre sin adivinar.

      El identificador es al azar y no solo la hora: en un servidor con
      tráfico, dos errores del mismo segundo quedan indistinguibles, y suelen
      ser justo los que hay que mirar juntos.
    */
    const cuando = new Date().toISOString();
    const errorId = randomUUID();
    this.logger.error(
      `${where} -> 500${who} [UNEXPECTED ${errorId} ${cuando}]: ${error?.message ?? "Unknown error"}`,
      error?.stack,
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: "UNEXPECTED",
      message:
        "Algo falló del lado del servidor y no es un error previsto. Quedó " +
        "registrado: pasá este código para encontrarlo.",
      errorId,
      at: cuando,
    });
  }

  /**
   * Los errores de la base que vale la pena nombrar.
   *
   * El que motivó todo esto es el primero: una tabla o una columna que el
   * código usa y que en la base no está. Pasa cuando una migración no corrió,
   * y el síntoma —un 500 mudo en una pantalla cualquiera— no se parece en nada
   * a la causa. Con el nombre de la tabla adelante, se arregla en un minuto.
   */
  private deLaBase(
    exception: unknown,
  ): { statusCode: number; code: string; message: string } | null {
    if (exception instanceof Prisma.PrismaClientInitializationError) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: "DB_UNAVAILABLE",
        message:
          "No se pudo conectar con la base de datos. Revisar DATABASE_URL y " +
          "que la base esté levantada.",
      };
    }

    if (!(exception instanceof Prisma.PrismaClientKnownRequestError)) {
      return null;
    }

    // De `meta` interesan dos nombres, y solo si de verdad son texto: Prisma
    // los tipa como desconocidos porque dependen del error.
    const meta = exception.meta ?? {};
    const nombre = (clave: string): string | null => {
      const valor = meta[clave];
      return typeof valor === "string" ? valor : null;
    };

    switch (exception.code) {
      case "P2021":
        return {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: "DB_TABLE_MISSING",
          message:
            `Falta la tabla ${nombre("table") ?? "que usa esta operación"} en ` +
            "la base: la migración no corrió. Ver GET /health/db.",
        };
      case "P2022":
        return {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: "DB_COLUMN_MISSING",
          message:
            `Falta la columna ${nombre("column") ?? "que usa esta operación"} ` +
            "en la base: la migración no corrió. Ver GET /health/db.",
        };
      case "P2002":
        return {
          statusCode: HttpStatus.CONFLICT,
          code: "DB_DUPLICATE",
          message: "Ya existe un registro con ese dato único.",
        };
      case "P2025":
        return {
          statusCode: HttpStatus.NOT_FOUND,
          code: "DB_NOT_FOUND",
          message: "No se encontró lo que se estaba por modificar.",
        };
      default:
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          code: `DB_${exception.code}`,
          message:
            `La base rechazó la operación (${exception.code}). Quedó el ` +
            "detalle en el log del servidor.",
        };
    }
  }
}
