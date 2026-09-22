import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { clientIp } from "../utils/client-ip.util";

/**
 * El limitador general, contando por la IP real del cliente.
 *
 * El ThrottlerGuard de Nest cuenta por `req.ip`, que detrás de Vercel es la IP
 * del proxy: todos los usuarios caían en el mismo contador.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(clientIp(req) ?? "unknown");
  }
}
