import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import Stripe from "stripe";

/**
 * stripe-error.filter.ts — Que un error del procesador diga qué pasó
 * ---------------------------------------------------------------------------
 * POR QUÉ EXISTE: cuando Stripe rechaza un pedido, el SDK tira un error que no
 * es una HttpException. El filtro global lo atrapa, escribe el detalle en el
 * log y le contesta al cliente `{"statusCode":500,"message":"Internal server
 * error"}`, que es lo correcto para un error inesperado.
 *
 * El problema es que un error de Stripe NO es inesperado: es una respuesta de
 * un servicio externo, y casi siempre dice exactamente qué está mal. "Invalid
 * currency: usd", "Your card was declined", "The amount is too large". Todo eso
 * terminaba convertido en un 500 mudo, y la única forma de leerlo era abrir los
 * logs del deploy —que administra otra persona—. O sea: la información existía
 * y no llegaba a nadie que pudiera hacer algo con ella.
 *
 * Es el mismo motivo por el que existe env-report.ts, y está dicho en su
 * encabezado: quien programa no puede abrir el panel de Vercel.
 *
 * ── QUÉ SE DEVUELVE Y QUÉ NO ──────────────────────────────────────────────
 * El mensaje de Stripe sí, y es a propósito. No contiene secretos: son las
 * validaciones de la API sobre el pedido que le mandamos. Lo que NO vuelve
 * nunca es el error de autenticación, porque ese habla de nuestra clave: ahí se
 * contesta que el cobro no está disponible y el detalle queda solo en el log.
 *
 * ── POR QUÉ UN FILTRO Y NO UN TRY/CATCH EN EL SERVICIO ────────────────────
 * Porque las llamadas al procesador están repartidas por todo el servicio
 * —crear intents, retener, capturar, soltar, transferir, dar de alta cuentas—
 * y envolverlas de a una significa catorce try/catch que hacen lo mismo y una
 * ruta nueva que alguien se va a olvidar de envolver. Acá se declara una vez
 * sobre el controlador y vale para todas.
 */
@Catch(Stripe.errors.StripeError)
export class StripeErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("StripeError");

  catch(error: Stripe.errors.StripeError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ method: string; originalUrl: string }>();

    const { statusCode, code, message, alLog } = this.traducir(error);

    // Siempre queda el detalle completo en el log, aunque al cliente le vaya
    // una versión recortada: es lo que permite reconstruir qué pasó.
    this.logger.error(
      `${request.method} ${request.originalUrl} -> ${statusCode} ` +
        `[${error.type}${error.code ? `/${error.code}` : ""}] ${alLog}`,
    );

    response.status(statusCode).json({ statusCode, code, message });
  }

  private traducir(error: Stripe.errors.StripeError): {
    statusCode: number;
    code: string;
    message: string;
    alLog: string;
  } {
    const detalle = error.message || "sin detalle";

    // LA TARJETA RECHAZADA NO ES UNA FALLA DEL SERVIDOR.
    //
    // Es el caso más común de todos y tiene su propio código HTTP: 402. El
    // mensaje de Stripe está escrito PARA quien pagó ("Tu tarjeta fue
    // rechazada", "El código de seguridad es incorrecto") y viene traducido al
    // idioma del pedido, así que se pasa tal cual: reemplazarlo por un texto
    // propio sería tirar la única información útil que tiene.
    if (error instanceof Stripe.errors.StripeCardError) {
      return {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        code: error.code ?? "card_declined",
        message: detalle,
        alLog: detalle,
      };
    }

    // EL PEDIDO ESTABA MAL ARMADO. No lo puede arreglar quien está pagando:
    // es la configuración del cobro. El ejemplo que motivó todo esto es una
    // cuenta de Stripe de un país que no cobra en la moneda de la reserva, que
    // contesta "Invalid currency" y quedaba como un 500 sin explicación.
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        code: "STRIPE_REQUEST_INVALID",
        message: `El procesador rechazó el pedido: ${detalle}`,
        alLog: detalle,
      };
    }

    // ACÁ NO VUELVE NADA. El mensaje habla de nuestra clave.
    if (error instanceof Stripe.errors.StripeAuthenticationError) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: "PAYMENTS_NOT_CONFIGURED",
        message:
          "El cobro con tarjeta no está disponible: revisar las claves de " +
          "Stripe del servidor.",
        alLog: detalle,
      };
    }

    // Stripe no contestó, o contestó que se cayó. No es culpa de nadie de este
    // lado y se puede volver a intentar, así que se dice eso.
    if (
      error instanceof Stripe.errors.StripeConnectionError ||
      error instanceof Stripe.errors.StripeAPIError ||
      error instanceof Stripe.errors.StripeRateLimitError
    ) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: "STRIPE_UNAVAILABLE",
        message:
          "El procesador de pagos no está respondiendo. Volvé a intentar en " +
          "un momento.",
        alLog: detalle,
      };
    }

    return {
      statusCode: HttpStatus.BAD_GATEWAY,
      code: "STRIPE_ERROR",
      message: `El procesador de pagos falló: ${detalle}`,
      alLog: detalle,
    };
  }
}
