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
    if (desdeProxy) return desdeProxy;
  }
  return req.ip || req.socket?.remoteAddress || null;
}

export function clientUserAgent(req: RequestLike): string | null {
  const ua = (req.headers ?? {})["user-agent"];
  const texto = Array.isArray(ua) ? ua[0] : ua;
  return texto ? texto.slice(0, 500) : null;
}
