import { UnauthorizedException } from "@nestjs/common";

/**
 * Cuánto antes del cambio de contraseña puede haberse emitido un token y
 * seguir valiendo.
 *
 * Existe por una cuestión de redondeo, no de seguridad: `iat` viene en
 * SEGUNDOS enteros (truncados) y `passwordChangedAt` en milisegundos. Un
 * token firmado 300 ms DESPUÉS del cambio tiene un `iat` que, pasado a
 * milisegundos, cae hasta 999 ms ANTES. Sin este margen, el login que la
 * persona hace justo después de recuperar la contraseña le daría un token que
 * ya nace revocado.
 */
const TOLERANCIA_MS = 1000;

/**
 * ¿Este token es de antes del último cambio de contraseña?
 *
 * Cambiar la contraseña después de un robo tiene que echar al que la robó. Sin
 * esto, su token seguía valiendo hasta vencer —días, con JWT_EXPIRES_IN en 7d—
 * y el cambio de contraseña no le sacaba nada: ya estaba adentro.
 *
 * Un token sin `iat` con la contraseña cambiada se trata como anterior al
 * cambio. Nosotros siempre lo ponemos; uno que no lo trae no salió de acá, y
 * ante la duda la sesión no vale.
 */
export function emitidoAntesDelCambioDeClave(
  iat: number | undefined,
  passwordChangedAt: Date | null | undefined,
): boolean {
  if (!passwordChangedAt) return false;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return true;
  return iat * 1000 < passwordChangedAt.getTime() - TOLERANCIA_MS;
}

/**
 * El 401 de una sesión que se cerró porque cambió la contraseña.
 *
 * Tiene código propio para que el front pueda decir POR QUÉ se cerró ("tu
 * contraseña cambió, volvé a entrar") en vez del "sesión vencida" genérico. No
 * cuenta nada que el portador del token no sepa ya: el token es de esa cuenta.
 */
export function sesionRevocada(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    code: "SESSION_REVOKED",
    message:
      "Tu sesión se cerró porque la contraseña de la cuenta cambió. Volvé a " +
      "iniciar sesión.",
  });
}
