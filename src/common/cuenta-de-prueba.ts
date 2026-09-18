/**
 * LA CUENTA DE PRUEBA: UNA PUERTA ABIERTA, A PROPÓSITO Y CON FECHA DE CIERRE.
 *
 * Mientras la plataforma es una demo hace falta poder recorrer el circuito
 * entero —subir el documento, esperar el análisis real, quedar verificado y
 * llegar a reservar— sin depender de tener a mano un documento que el OCR lea
 * perfecto y una licencia vigente y sin período de principiante. Esto hace
 * exactamente eso, para UNA cuenta.
 *
 * Lo que NO hace: saltear el análisis. El documento se manda, se lee y se
 * cruza igual que el de cualquiera, y tarda lo mismo. Lo único que cambia es
 * el veredicto final, y los motivos reales quedan guardados para poder verlos.
 * Si se salteara el análisis, la cuenta de prueba dejaría de servir para
 * probar justamente la parte que más se rompe.
 *
 * ── Por qué es una variable de entorno y no un mail escrito acá ─────────────
 * Este repositorio es público. Un mail hardcodeado publicaría cuál es la
 * cuenta que saltea la verificación de identidad de la plataforma, que es una
 * invitación bastante directa. Además, así un deploy que no defina la variable
 * no tiene ninguna puerta abierta: lo seguro es el estado por omisión, y
 * abrirla es un acto explícito en un panel, no algo que se arrastra sin que
 * nadie se acuerde.
 *
 * ── CÓMO SACAR ESTO CUANDO LA FASE DE PRUEBA TERMINE ────────────────────────
 * 1. Borrar `VERIFICACION_CUENTA_DE_PRUEBA` del panel de Vercel. Con eso solo
 *    ya deja de tener efecto en producción, sin necesidad de un deploy.
 * 2. Borrar este archivo.
 * 3. Borrar sus dos usos: el bloque final de `IdentityMatchService.evaluate`
 *    y el de `evaluateDrivingEligibility`.
 * 4. Borrar los `describe` llamados "la cuenta de prueba" de
 *    `identity-match.service.spec.ts` y de `driving-eligibility.spec.ts`.
 *
 * El compilador señala los pasos 3 y 4 apenas se hace el 2, así que no hay
 * forma de dejar la mitad puesta sin enterarse.
 */

/** La variable que nombra a la cuenta de prueba. Sin ella no hay ninguna. */
const VARIABLE = "VERIFICACION_CUENTA_DE_PRUEBA";

/**
 * ¿Es ésta la cuenta de prueba?
 *
 * Sin la variable definida devuelve `false` siempre. Importa que el orden sea
 * ése: si se comparara primero, una cuenta sin mail contra una variable vacía
 * darían "iguales" y toda la plataforma sería cuenta de prueba.
 *
 * La comparación ignora mayúsculas y espacios de más porque la variable la
 * escribe una persona en un panel web, y un espacio pegado al pegar el mail no
 * puede ser la diferencia entre que esto funcione y no.
 */
export function esLaCuentaDePrueba(email: string | null | undefined): boolean {
  const configurado = (process.env[VARIABLE] ?? "").trim().toLowerCase();
  if (!configurado) return false;

  return (email ?? "").trim().toLowerCase() === configurado;
}
