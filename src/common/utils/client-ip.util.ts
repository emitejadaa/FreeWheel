/**
 * LA IP DE QUIEN HIZO EL PEDIDO, NO LA DEL PROXY.
 *
 * Detrás de Vercel, `req.ip` es la IP de su infraestructura: la misma para
 * todo el mundo. Usarla para limitar pedidos significaba que todos los
 * usuarios compartían un solo contador —el primero que abusaba dejaba sin
 * servicio a los demás— y usarla para el registro antifraude no identificaba a
 * nadie.
 *
 * Vercel pone la IP real del cliente en sus propias cabeceras y SOBRESCRIBE lo
 * que mande el cliente, así que ahí son confiables. Fuera de Vercel no hay nadie
 * que las sobrescriba: un cliente puede mandar `x-forwarded-for: 1.2.3.4` y
 * hacerse pasar por otra IP. Por eso solo se leen cuando se corre en Vercel (o
 * cuando TRUST_PROXY_HEADERS lo dice explícitamente, para otro proxy de
 * confianza).
 */
import { isIPv4, isIPv6 } from "net";

interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

function primera(valor: string | string[] | undefined): string | undefined {
  const texto = Array.isArray(valor) ? valor[0] : valor;
  return texto?.split(",")[0]?.trim() || undefined;
}

function confiarEnCabeceras(): boolean {
  if (process.env.VERCEL) return true;
  return (process.env.TRUST_PROXY_HEADERS ?? "").toLowerCase() === "true";
}

export function clientIp(req: RequestLike): string | null {
  const headers = req.headers ?? {};
  if (confiarEnCabeceras()) {
    const desdeProxy =
      primera(headers["x-vercel-forwarded-for"]) ??
      primera(headers["x-real-ip"]) ??
      primera(headers["x-forwarded-for"]);
    if (desdeProxy) return sinPrefijoIpv6(desdeProxy);
  }
  const directa = req.ip || req.socket?.remoteAddress;
  return directa ? sinPrefijoIpv6(directa) : null;
}

/**
 * Una IPv4 escrita como IPv6 ("::ffff:1.2.3.4") es como Node muestra la
 * dirección en un socket dual. Es la misma IP: se guarda y se cuenta como la
 * IPv4 que es, así no depende de cómo escucha el servidor.
 */
function sinPrefijoIpv6(ip: string): string {
  const limpia = ip.trim();
  const mapeada = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(limpia)?.[1];
  return mapeada && isIPv4(mapeada) ? mapeada : limpia;
}

/**
 * La IP como clave de contador, para los dos limitadores (el de memoria y el
 * persistente): si cada uno contara distinto, el mismo cliente tendría topes
 * distintos según cuál lo mirara.
 *
 * Una IPv6 se cuenta por su /64 y no entera. A una conexión hogareña o a un
 * servidor alquilado le dan un /64 completo —dieciocho trillones de
 * direcciones— y cambiar de una a otra es gratis: contar la dirección exacta
 * sería darle un contador nuevo a cada intento. El /64 es lo que identifica a
 * la conexión, igual que una IPv4.
 */
export function ipRateLimitKey(ip: string | null): string {
  if (!ip) return "unknown";
  const limpia = sinPrefijoIpv6(ip).toLowerCase();
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

export function clientUserAgent(req: RequestLike): string | null {
  const ua = (req.headers ?? {})["user-agent"];
  const texto = Array.isArray(ua) ? ua[0] : ua;
  return texto ? texto.slice(0, 500) : null;
}
