import { Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";

const logger = new Logger("Bootstrap");

/** Lo que body-parser le pone a sus errores. */
interface ErrorDelParser {
  status?: number;
  type?: string;
}

/**
 * LO QUE FALLA ANTES DE QUE EL PEDIDO LLEGUE A NEST.
 *
 * Por acá pasan dos cosas muy distintas, y antes se contestaban igual (503):
 *
 *  · Un pedido mal armado —JSON inválido, un cuerpo demasiado grande—. Lo
 *    rechaza el parser de Express, que corre antes que Nest. Es un error de
 *    quien pide: 400/413, y no una caída de la API que haga sonar alarmas.
 *
 *  · Nest que no pudo arrancar (una variable que falta, la base que no
 *    contesta). Eso sí es un 503. Fuera de producción el motivo viaja en la
 *    respuesta para diagnosticar desde el navegador; en producción se devuelve
 *    un identificador y la hora, igual que AllExceptionsFilter, porque el
 *    mensaje de Prisma trae el host de la base. GET /health/env y /health/db
 *    dicen qué falta sin exponer nada.
 */
export function expressErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const { status, type } = (err ?? {}) as ErrorDelParser;

  if (typeof status === "number" && status >= 400 && status < 500) {
    const demasiadoGrande = type === "entity.too.large" || status === 413;
    const jsonInvalido = type === "entity.parse.failed";
    logger.warn(
      `Pedido rechazado antes de Nest (${status}${type ? ` ${type}` : ""})`,
    );
    res.status(status).json({
      statusCode: status,
      code: demasiadoGrande
        ? "PAYLOAD_TOO_LARGE"
        : jsonInvalido
          ? "INVALID_JSON"
          : "BAD_REQUEST",
      message: demasiadoGrande
        ? "El cuerpo del pedido es demasiado grande."
        : jsonInvalido
          ? "El cuerpo del pedido no es un JSON válido."
          : "El pedido no es válido.",
    });
    return;
  }

  const at = new Date().toISOString();
  const errorId = randomUUID();
  logger.error(
    `La API no pudo atender el pedido [${errorId} ${at}]`,
    err instanceof Error ? err.stack : String(err),
  );
  const detalle =
    process.env.NODE_ENV !== "production" && err instanceof Error
      ? err.message
      : null;
  res.status(503).json({
    code: "API_NO_DISPONIBLE",
    message:
      detalle ??
      "La API no pudo iniciarse. Quedó registrado: pasá este código para encontrarlo.",
    errorId,
    at,
  });
}
