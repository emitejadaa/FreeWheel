import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { clientIp, ipRateLimitKey } from "../utils/client-ip.util";

/**
 * El limitador general, contando por la IP real del cliente.
 *
 * El ThrottlerGuard de Nest cuenta por `req.ip`, que detrás de Vercel es la IP
 * del proxy: todos los usuarios caían en el mismo contador. La clave es la misma
 * que usa el limitador persistente (IPv6 agrupada por /64).
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(ipRateLimitKey(clientIp(req)));
  }
}
