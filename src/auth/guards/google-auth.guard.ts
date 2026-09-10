import {
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/**
 * El guardia de "entrar con Google", que además contesta algo entendible cuando
 * ese botón no está configurado en el servidor.
 *
 * ── EL PROBLEMA QUE ARREGLA ────────────────────────────────────────────────
 * La estrategia de Google se registra SOLO si están cargadas GOOGLE_CLIENT_ID y
 * GOOGLE_CLIENT_SECRET (ver auth.module.ts). Eso está bien: sin credenciales,
 * passport-google-oauth20 revienta al construirse y se llevaría puesta la
 * aplicación entera, así que se prefiere que arranque sin ese botón.
 *
 * Lo que faltaba era el otro lado. Sin la estrategia registrada, entrar a
 * /auth/google hacía que passport tirara `Unknown authentication strategy
 * "google"`, y eso llega al navegador como:
 *
 *     { "statusCode": 500, "message": "Internal server error" }
 *
 * O sea: una situación PREVISTA —tan prevista que env-report.ts la enumera y
 * dice qué se pierde— se muestra como si el servidor se hubiera roto. Quien lo
 * ve no tiene forma de saber que faltan dos variables de entorno y que el resto
 * de la aplicación anda perfecto.
 *
 * Ahora contesta 503 con un motivo y un código. No arregla la configuración
 * —eso es cargar las dos variables en el deploy— pero dice qué hay que cargar,
 * que es todo lo que puede hacer un servidor al que le faltan sus credenciales.
 *
 * Cómo se comprueba desde afuera, sin entrar al panel del proveedor:
 * GET /health/env dice qué variables faltan.
 */
@Injectable()
export class GoogleAuthGuard extends AuthGuard("google") {
  canActivate(context: ExecutionContext) {
    if (!googleLoginConfigurado()) {
      throw new ServiceUnavailableException({
        code: "GOOGLE_LOGIN_UNAVAILABLE",
        message:
          "Entrar con Google no está configurado en este servidor: faltan " +
          "GOOGLE_CLIENT_ID y/o GOOGLE_CLIENT_SECRET. El registro con email y " +
          "contraseña funciona igual. Ver GET /health/env.",
      });
    }
    return super.canActivate(context);
  }
}

/**
 * Las mismas dos variables que mira auth.module.ts para decidir si registra la
 * estrategia. Se leen de process.env y no del ConfigService a propósito: es
 * exactamente la misma fuente que usa el módulo, y si las dos preguntas se
 * hicieran distinto podrían contestar distinto, que es la única forma de que
 * este guardia vuelva a dejar pasar un pedido que después falla.
 */
export const googleLoginConfigurado = (): boolean =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
