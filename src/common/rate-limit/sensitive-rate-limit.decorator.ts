import { applyDecorators, SetMetadata, UseGuards } from "@nestjs/common";
import { SensitiveRateLimitGuard } from "./sensitive-rate-limit.guard";

export const SENSITIVE_RATE_LIMIT_KEY = "sensitiveRateLimit";

/**
 * Límite de pedidos PERSISTENTE (en la base, compartido entre instancias) para
 * rutas sensibles: login, códigos, pagos, reservas.
 *
 * - `name`: identifica el contador ("auth.login"). Dos rutas con el mismo
 *   nombre comparten contador.
 * - `limit` pedidos por `windowSec` segundos.
 * - `blockSec`: al pasarse, cuánto queda bloqueado (por omisión, la ventana).
 * - `by`: contra qué se cuenta. "ip" (por omisión), "user" (requiere sesión:
 *   el guard corre después de JwtAuthGuard) o "ip+user".
 *
 * Se aplica como guard a nivel de método, así corre DESPUÉS de los guards de
 * la clase (JwtAuthGuard) y puede contar por usuario.
 */
export interface SensitiveRateLimitOptions {
  name: string;
  limit: number;
  windowSec: number;
  blockSec?: number;
  by?: "ip" | "user" | "ip+user";
}

export const SensitiveRateLimit = (options: SensitiveRateLimitOptions) =>
  applyDecorators(
    SetMetadata(SENSITIVE_RATE_LIMIT_KEY, options),
    UseGuards(SensitiveRateLimitGuard),
  );
