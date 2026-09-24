import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import { MercadoPagoApiError } from "../providers/mercadopago/mercadopago.provider";

/**
 * QUE UN ERROR DEL PROCESADOR DIGA QUÉ PASÓ.
 *
 * Un error de la API de Mercado Pago no es una HttpException, así que sin
 * esto el filtro global lo convertía en un 500 mudo. Pero no es un error
 * inesperado: es la respuesta de un servicio externo, y casi siempre dice qué
 * está mal ("Invalid card_token_id", "invalid_grant").
 *
 * Un pago RECHAZADO no pasa por acá: Mercado Pago lo contesta como un
 * resultado (201 con `status: rejected`) y el servicio lo devuelve como tal.
 * Esto es para lo que ni siquiera se pudo intentar.
 *
 * ── Qué se devuelve y qué no ─────────────────────────────────────────────────
 * El mensaje de Mercado Pago sí: son validaciones sobre el pedido, no
 * secretos. Lo que NO vuelve nunca es un 401 del lado de Mercado Pago, porque
 * habla de un token nuestro o del dueño: ahí se contesta que la cuenta de
 * cobro hay que volver a vincularla, y el detalle queda en el log.
 */
@Catch(MercadoPagoApiError)
export class ProcessorErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("ProcessorError");

  catch(error: MercadoPagoApiError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ method: string; originalUrl: string }>();

    const { statusCode, code, message } = this.traducir(error);
    this.logger.error(
      `${request.method} ${request.originalUrl} -> ${statusCode} ` +
        `[MP ${error.httpStatus}/${error.code}] ${error.message}`,
    );
    response
      .status(statusCode)
      .json({ statusCode, code, message, processorCode: error.code });
  }

  private traducir(error: MercadoPagoApiError): {
    statusCode: number;
    code: string;
    message: string;
  } {
    if (error.code === "MP_OAUTH_NOT_CONFIGURED") {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: "PAYMENTS_NOT_CONFIGURED",
        message: error.message,
      };
    }
    // El token del dueño ya no sirve (lo desvinculó, venció sin renovarse).
    if (error.httpStatus === 401 || error.httpStatus === 403) {
      return {
        statusCode: HttpStatus.CONFLICT,
        code: "OWNER_PAYMENTS_RELINK_REQUIRED",
        message:
          "La cuenta de Mercado Pago del dueño necesita volver a vincularse " +
          "para poder cobrar.",
      };
    }
    // El pedido estaba mal armado: casi siempre un token de tarjeta vencido
    // o ya usado (duran minutos y sirven una sola vez).
    if (error.httpStatus >= 400 && error.httpStatus < 500) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        code: "PROCESSOR_REQUEST_INVALID",
        message: `Mercado Pago rechazó el pedido: ${error.message}`,
      };
    }
    return {
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: "PROCESSOR_UNAVAILABLE",
      // No se puede decir "no se cobró nada": si el pedido llegó y lo que se
      // cortó fue la respuesta, el cobro existe. Lo encuentra el aviso de
      // Mercado Pago (ver PaymentsService.adoptarPagoHuerfano) y la reserva
      // se actualiza sola.
      message:
        "Mercado Pago no respondió. Antes de volver a pagar, mirá el estado " +
        "de la reserva en unos minutos: si el cobro llegó a hacerse, va a " +
        "aparecer ahí.",
    };
  }
}
