import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Request, Response } from "express";

/** Los códigos de estado que son culpa nuestra, no de quien llamó. */
function esErrorNuestro(status: number): boolean {
  return status >= (HttpStatus.INTERNAL_SERVER_ERROR as number);
}

/**
 * LO QUE SE CUENTA CUANDO ALGO FALLA.
 *
 * Un error 4xx se cuenta entero: quien llamó necesita saber qué mandó mal, y
 * ahí viajan los códigos con los que el front decide qué pantalla mostrar
 * (CONTRACT_NOT_ACCEPTED, DEPOSIT_AUTHORIZATION_REQUIRED, y demás).
 *
 * Un error 5xx no se cuenta NUNCA. El mensaje de una excepción interna suele
 * traer la consulta que falló, el nombre de la tabla, una ruta del servidor o
 * un fragmento de lo que se estaba procesando —que acá puede ser el número de
 * un documento—. En su lugar sale un identificador al azar que también queda
 * en el log: con ese código se encuentra el error completo del lado del
 * servidor, sin que el cliente haya visto nada.
 *
 * Nota sobre las 5xx modeladas como HttpException: antes se devolvían tal cual
 * porque "alguien las escribió a propósito". Pero un 503 escrito a propósito
 * igual arrastra el mensaje de la causa (por ejemplo, el detalle del
 * procesador de pagos), así que también se recortan.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const userId = (request.user as { id?: string } | undefined)?.id;
    // Método + ruta + usuario se pueden registrar; las cabeceras y el cuerpo
    // no, porque llevan tokens, contraseñas y datos de documentos.
    const where = `${request.method} ${request.originalUrl}`;
    const who = userId ? ` user=${userId}` : "";

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : (HttpStatus.INTERNAL_SERVER_ERROR as number);

    if (!esErrorNuestro(status) && exception instanceof HttpException) {
      const payload = exception.getResponse();
      this.logger.warn(`${where} -> ${status}${who}: ${exception.message}`);
      response
        .status(status)
        .json(
          typeof payload === "string"
            ? { statusCode: status, message: payload }
            : payload,
        );
      return;
    }

    const error = exception instanceof Error ? exception : undefined;
    const errorId = randomUUID();

    this.logger.error(
      `${where} -> ${status}${who} errorId=${errorId}: ` +
        (error?.message ?? "Unknown error"),
      error?.stack,
    );

    response.status(status).json({
      statusCode: status,
      code: "INTERNAL_ERROR",
      message:
        "Algo falló de nuestro lado. Si necesitás reportarlo, pasá este código.",
      errorId,
    });
  }
}
