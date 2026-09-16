/**
 * ⚠️  MODO DEMO — CÓDIGO TEMPORAL, PARA REVERTIR ⚠️
 *
 * Este archivo entero, y los usos de `modoDemo()` que hay repartidos, existen
 * para poder recorrer los flujos de verificación de punta a punta desde el
 * front sin quedar trabado en controles que en una prueba no aportan nada:
 * una licencia de principiante, un documento vencido, una cuenta de 17 años.
 *
 * NO ES UNA FUNCIONALIDAD. Es un andamio. Se quita con:
 *
 *     git revert <el commit que trajo este archivo>
 *
 * y el commit está hecho para que eso alcance: todo lo temporal entró junto y
 * nada más entró con ello.
 *
 * ── Qué relaja, exactamente ──────────────────────────────────────────────────
 *
 *   · la edad mínima baja de 18 a 17 años;
 *   · ser principiante deja de impedir alquilar;
 *   · no se mira el vencimiento de los documentos (ni el del DNI, ni el de la
 *     licencia, ni para aprobar ni para alquilar);
 *   · la clase de la licencia deja de importar;
 *   · de los datos que hay que poder leer queda solo lo esencial: nombre,
 *     apellido y número de documento;
 *   · el DNI deja de exigir su código (PDF417 o QR).
 *
 * ── Qué NO relaja, y es a propósito ─────────────────────────────────────────
 * Lo único que este modo sigue exigiendo es lo que la verificación existe para
 * comprobar: que el nombre, el apellido, el DNI y el CUIL digan lo mismo en el
 * documento y en la cuenta, y que el documento no se contradiga a sí mismo.
 * Sin eso el flujo aprobaría cualquier cosa y probarlo no demostraría nada.
 *
 * Tampoco toca el antifraude del documento duplicado: una misma identidad
 * sigue sin poder verificar dos cuentas. Para probar con varias cuentas hay
 * que usar un DNI distinto en cada una.
 *
 * ── El interruptor ──────────────────────────────────────────────────────────
 * Arranca ENCENDIDO, porque el deploy en el que se prueba no tiene por qué
 * saber que esta variable existe. Se apaga sin revertir nada con:
 *
 *     VERIFICATION_DEMO_MODE="false"
 *
 * Se lee de `process.env` en cada llamada y no una vez al importar: las dos
 * funciones que lo consultan (la validación de la fecha de nacimiento y el
 * control de habilitación) son puras y no pasan por el contenedor de Nest, así
 * que no tienen un ConfigService a mano — y leerlo en cada llamada es además
 * lo que permite encenderlo y apagarlo desde un test.
 */

/** Si los controles de verificación están relajados para probar. */
export function modoDemo(): boolean {
  return (
    (process.env.VERIFICATION_DEMO_MODE ?? "true").trim().toLowerCase() !==
    "false"
  );
}

/** La edad mínima para usar la plataforma: 18 en serio, 17 probando. */
export function edadMinima(): number {
  return modoDemo() ? 17 : 18;
}
