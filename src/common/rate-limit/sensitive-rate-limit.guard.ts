import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { isIPv4, isIPv6 } from "net";
import { clientIp } from "../utils/client-ip.util";
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
  const ip = `${opciones.name}:ip:${claveDeIp(clientIp(pedido))}`;
  const userId = pedido.user?.id;
  const usuario = userId ? `${opciones.name}:user:${userId}` : null;

  if (por === "user") return [usuario ?? ip];
  if (por === "ip+user") return usuario ? [ip, usuario] : [ip];
  return [ip];
}

/**
 * La IP como clave de contador.
 *
 * Una IPv6 se cuenta por su /64 y no entera. A una conexión hogareña o a un
 * servidor alquilado le dan un /64 completo —dieciocho trillones de
 * direcciones— y cambiar de una a otra es gratis: contar la dirección exacta
 * sería darle un contador nuevo a cada intento. El /64 es lo que identifica a
 * la conexión, igual que una IPv4.
 *
 * Una IPv4 escrita como IPv6 ("::ffff:1.2.3.4", que es como Node la muestra en
 * un socket dual) se cuenta como la IPv4 que es: si no, la misma persona
 * tendría dos contadores según por dónde entró el pedido.
 */
export function claveDeIp(ip: string | null): string {
  if (!ip) return "unknown";
  const limpia = ip.trim().toLowerCase();

  const mapeada = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(limpia)?.[1];
  if (mapeada && isIPv4(mapeada)) return mapeada;
  if (!isIPv6(limpia.split("%")[0])) return limpia;

  const grupos = expandirIpv6(limpia.split("%")[0]);
  return grupos
    ? `${grupos
        .slice(0, 4)
        .map((g) => parseInt(g, 16).toString(16))
        .join(":")}::/64`
    : limpia;
}

/** "2001:db8::1" → los ocho grupos, con los ceros que "::" esconde. */
function expandirIpv6(ip: string): string[] | null {
  const partes = ip.split("::");
  if (partes.length > 2) return null;

  const aGrupos = (texto: string): string[] => {
    if (!texto) return [];
    // Una IPv4 embebida al final ocupa los dos últimos grupos.
    return texto.split(":").flatMap((grupo) => {
      if (!grupo.includes(".")) return [grupo];
      const [a, b, c, d] = grupo.split(".").map(Number);
      return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
    });
  };

  const cabeza = aGrupos(partes[0]);
  if (partes.length === 1) return cabeza.length === 8 ? cabeza : null;

  const cola = aGrupos(partes[1]);
  const ceros = 8 - cabeza.length - cola.length;
  if (ceros < 0) return null;
  return [...cabeza, ...Array<string>(ceros).fill("0"), ...cola];
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
