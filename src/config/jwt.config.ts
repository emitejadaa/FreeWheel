import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * El secreto con el que se firma en desarrollo cuando JWT_SECRET no está.
 * Es público —está en este archivo—, así que en producción no se acepta nunca.
 */
const DEFAULT_JWT_SECRET = "freewheel-secret-key-change-in-production";

/**
 * Los valores de ejemplo que trae la documentación (.env.example, README).
 * Son tan públicos como el de arriba: un deploy que los copió tal cual firma
 * tokens que cualquiera que haya leído el README puede falsificar.
 */
const SECRETOS_DE_EJEMPLO = new Set([
  DEFAULT_JWT_SECRET,
  "replace-with-a-secure-secret",
]);

/** Por debajo de esto no se arranca en producción. */
const LARGO_MINIMO = 16;
/** Por debajo de esto se arranca, pero se avisa. */
const LARGO_RECOMENDADO = 32;

/**
 * UN SOLO ALGORITMO, FIJADO, AL FIRMAR Y AL VERIFICAR.
 *
 * Sin fijarlo, quien verifica acepta el algoritmo que diga el propio token.
 * Es la puerta de los ataques clásicos contra JWT: un token con `alg: none`, o
 * uno firmado con HS256 usando como "secreto" algo público cuando el servidor
 * espera otra cosa. Firmamos siempre con HS256, así que no hay ningún motivo
 * para aceptar otro.
 */
export const JWT_ALGORITHM = "HS256" as const;

const logger = new Logger("JwtConfig");
let avisoDeSecretoCorto = false;

/**
 * El secreto de las sesiones.
 *
 * ── En producción, sin un secreto de verdad NO SE ARRANCA ───────────────────
 * Antes, sin JWT_SECRET se caía a un valor fijo escrito en este archivo, y con
 * ese valor cualquiera puede fabricarse un token de administrador. Un deploy
 * que arranca así no está "funcionando con una advertencia": está abierto. Es
 * preferible que no levante —el error dice qué falta— a que atienda pedidos
 * firmados con una clave que está en GitHub.
 *
 * Lo mismo con los valores de ejemplo de la documentación y con un secreto
 * corto: HS256 con un secreto de pocos caracteres se rompe probando offline
 * con un solo token capturado, sin tocar el servidor, así que el límite de
 * pedidos no lo protege.
 *
 * ── Fuera de producción, como antes ─────────────────────────────────────────
 * Se usa el valor de desarrollo si no hay otro, para que el proyecto levante
 * en una máquina nueva sin configurar nada.
 */
export function getJwtSecret(configService: ConfigService): string {
  const secreto = configService.get<string>("JWT_SECRET");
  const enProduccion =
    (configService.get<string>("NODE_ENV") ?? process.env.NODE_ENV) ===
    "production";

  if (!enProduccion) return secreto ?? DEFAULT_JWT_SECRET;

  // Se valida la versión sin espacios pero se DEVUELVE el valor tal cual: si
  // el secreto cargado tuviera un espacio al final, recortarlo acá cambiaría
  // la clave con la que se verifican los tokens que ya están emitidos.
  const limpio = secreto?.trim() ?? "";
  if (!limpio) {
    throw new Error(
      "JWT_SECRET no está configurada. En producción no se arranca sin ella: " +
        "sin un secreto propio, cualquiera podría fabricarse una sesión. " +
        "Generala con `openssl rand -base64 48` y cargala en el deploy.",
    );
  }
  if (SECRETOS_DE_EJEMPLO.has(limpio)) {
    throw new Error(
      "JWT_SECRET tiene el valor de ejemplo de la documentación, que es " +
        "público. Generá uno propio con `openssl rand -base64 48`.",
    );
  }
  if (limpio.length < LARGO_MINIMO) {
    throw new Error(
      `JWT_SECRET es demasiado corta (menos de ${LARGO_MINIMO} caracteres): ` +
        "un secreto así se adivina probando offline con un solo token. " +
        "Generá uno con `openssl rand -base64 48`.",
    );
  }
  if (limpio.length < LARGO_RECOMENDADO && !avisoDeSecretoCorto) {
    avisoDeSecretoCorto = true;
    logger.warn(
      `JWT_SECRET tiene menos de ${LARGO_RECOMENDADO} caracteres. Anda, pero ` +
        "conviene rotarla por una más larga (`openssl rand -base64 48`); " +
        "rotarla cierra todas las sesiones abiertas.",
    );
  }
  return secreto as string;
}
