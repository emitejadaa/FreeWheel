import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { clientIp, ipRateLimitKey } from "../utils/client-ip.util";
import { RateLimitResult, RateLimitService } from "./rate-limit.service";
// El decorador importa este guard y este guard importa la clave del
// decorador. El ciclo es inofensivo: cada lado usa lo del otro recién cuando
// se decora una clase o llega un pedido, nunca mientras el módulo se carga.
import {
  SENSITIVE_RATE_LIMIT_KEY,
  type SensitiveRateLimitOptions,
} from "./sensitive-rate-limit.decorator";

interface PedidoConUsuario {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
  user?: { id?: string } | null;
}

interface RespuestaConCabeceras {
  setHeader?: (nombre: string, valor: string) => unknown;
}

/**
 * EL GUARD DE @SensitiveRateLimit: cuenta el pedido y, si se pasó, lo frena.
 *
 * Va a nivel de método (lo pone el decorador), así corre DESPUÉS de los guards
 * de la clase: en un controller con `@UseGuards(JwtAuthGuard)` arriba, cuando
 * este corre ya se sabe quién es, y se puede contar por usuario.
 *
 * El 429 lleva `code: "RATE_LIMITED"` y `retryAfterSec`, además de la cabecera
 * Retry-After. El front ramifica por el código, y con los segundos puede
 * deshabilitar el botón exactamente lo que hace falta en vez de adivinar.
 */
@Injectable()
export class SensitiveRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const opciones = this.reflector.getAllAndOverride<
      SensitiveRateLimitOptions | undefined
    >(SENSITIVE_RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (!opciones || context.getType() !== "http") return true;

    const http = context.switchToHttp();
    const pedido = http.getRequest<PedidoConUsuario>();
    const claves = sensitiveRateLimitKeys(opciones, pedido);

    // Con "ip+user" se cuentan las dos, aunque la primera ya esté bloqueada:
    // si no, un atacante bloqueado por IP dejaría de sumar contra la cuenta,
    // y cambiar de IP le devolvería el crédito entero.
    const resultados: RateLimitResult[] = await Promise.all(
      claves.map((clave) =>
        this.rateLimit.hit(
          clave,
          opciones.limit,
          opciones.windowSec,
          opciones.blockSec,
        ),
      ),
    );

    const frenados = resultados.filter((r) => !r.allowed);
    if (frenados.length === 0) return true;

    const retryAfterSec = Math.max(1, ...frenados.map((r) => r.retryAfterSec));
    http
      .getResponse<RespuestaConCabeceras>()
      .setHeader?.("Retry-After", String(retryAfterSec));

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: "RATE_LIMITED",
        message: mensajeDeEspera(retryAfterSec),
        retryAfterSec,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Contra qué claves se cuenta este pedido.
 *
 * "user" sin sesión cuenta por IP en vez de no contar. Pasa solo si alguien
 * pone el decorador en una ruta sin JwtAuthGuard, y es un error de quien lo
 * puso; pero la alternativa —dejar la ruta sin límite en silencio— es
 * justamente la que nadie nota hasta que la usan para probar códigos.
 */
export function sensitiveRateLimitKeys(
  opciones: SensitiveRateLimitOptions,
  pedido: PedidoConUsuario,
): string[] {
  const por = opciones.by ?? "ip";
  const ip = `${opciones.name}:ip:${ipRateLimitKey(clientIp(pedido))}`;
  const userId = pedido.user?.id;
  const usuario = userId ? `${opciones.name}:user:${userId}` : null;

  if (por === "user") return [usuario ?? ip];
  if (por === "ip+user") return usuario ? [ip, usuario] : [ip];
  return [ip];
}

/** "Esperá 15 minutos", en castellano y redondeado para arriba. */
function mensajeDeEspera(segundos: number): string {
  const base = "Hiciste demasiados intentos seguidos.";
  if (segundos < 60) {
    return `${base} Esperá ${segundos} ${segundos === 1 ? "segundo" : "segundos"} y volvé a probar.`;
  }
  const minutos = Math.ceil(segundos / 60);
  return `${base} Esperá ${minutos} ${minutos === 1 ? "minuto" : "minutos"} y volvé a probar.`;
}
