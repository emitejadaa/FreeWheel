import { UserRole, UserStatus } from "@prisma/client";

/**
 * exentos.ts — Las cuentas a las que los topes no se les aplican
 * ---------------------------------------------------------------------------
 * POR QUÉ EXISTE ESTO, Y POR QUÉ ES PELIGROSO.
 *
 * Una lista de excepciones a un control de seguridad es, por definición, la
 * primera puerta que alguien que entró al sistema va a buscar. Así que esta
 * tiene que ser corta, explícita y aburrida: nada de "si cumple tal condición",
 * nada de interruptores generales. Tres casos, cada uno con su motivo escrito.
 *
 * ── 1. LAS CUENTAS ADMINISTRADORAS ────────────────────────────────────────
 * Quien administra el sistema prueba el sistema: carga autos de ejemplo, cierra
 * reservas a mano, deja reseñas para ver cómo se ven. Esa es exactamente la
 * forma que los topes buscan, y suspender a la cuenta que tiene que resolver
 * las suspensiones es un lindo nudo del que no se sale.
 *
 * No es gratis: un administrador queda sin este control. Se acepta porque un
 * administrador ya puede cambiar el rango de cualquiera, suspender a cualquiera
 * y borrar cuentas. Si esa cuenta cae en malas manos, los topes de reseñas son
 * el problema más chico que hay.
 *
 * ── 2. LAS CUENTAS DE DEMOSTRACIÓN ────────────────────────────────────────
 * El historial que se carga en el deploy (prisma/backfill/historial-
 * demostracion.sql) arma alquileres cruzados entre las mismas cuentas: en los
 * números, es un anillo de reseñas perfecto. Lo es porque son datos sembrados,
 * no conducta. Sin esta excepción, el panel abriría con media docena de alertas
 * contra cuentas que no hicieron nada.
 *
 * Van por el dominio @freewheel.demo, que NO EXISTE. Nadie puede registrarse
 * con una dirección de ahí porque el alta pide verificar el mail, así que la
 * excepción no se puede usar para colarse.
 *
 * ── 3. LAS QUE DIGA LA VARIABLE DE ENTORNO ────────────────────────────────
 * ANTIFRAUDE_EXENTOS, separadas por coma. Es la válvula para el día que haga
 * falta sacar a alguien del control sin publicar código: una cuenta de una
 * agencia que carga treinta autos, una demostración en vivo. Queda escrito en
 * la configuración del deploy, que es un lugar que se audita.
 */

/** Lo que esta política necesita saber de una cuenta. */
export interface CuentaParaExencion {
  email: string;
  role: UserRole;
  status?: UserStatus;
}

/** El dominio de las cuentas sembradas. No existe: ver la nota de arriba. */
export const DOMINIO_DE_DEMOSTRACION = "@freewheel.demo";

/**
 * Lee la lista de la variable de entorno.
 *
 * Tolera espacios, mayúsculas y comas de más: una lista de configuración que
 * falla por un espacio es una lista que alguien va a terminar escribiendo mal
 * un viernes.
 */
export function exentosDeLaConfiguracion(valor: string | undefined): string[] {
  return (valor ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length > 0);
}

/**
 * ¿A esta cuenta se le saltean los topes y las señales?
 *
 * `extras` son los mails de la variable de entorno, ya leídos. Entran por
 * parámetro y no se leen acá adentro para que esto siga siendo una función
 * pura: una regla de seguridad que depende del ambiente no se puede probar.
 */
export function esCuentaExenta(
  cuenta: CuentaParaExencion | null | undefined,
  extras: string[] = [],
): boolean {
  if (!cuenta) return false;
  const email = (cuenta.email ?? "").trim().toLowerCase();
  if (cuenta.role === UserRole.ADMIN) return true;
  if (email.endsWith(DOMINIO_DE_DEMOSTRACION)) return true;
  return extras.includes(email);
}
