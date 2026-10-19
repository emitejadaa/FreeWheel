/**
 * CUANDO LA TRANSFERENCIA AL DUEÑO SE SIMULA
 *
 * Freewheel es un proyecto escolar. El pago de quien alquila ya se hace contra
 * Stripe EN MODO DE PRUEBA: la tarjeta 4242 se cobra de verdad contra la API de
 * Stripe, con sus rechazos y su 3-D Secure, pero no se mueve un peso real.
 *
 * La otra mitad del circuito —pagarle al dueño— no se puede hacer igual. Para
 * transferirle plata a otra persona hace falta Stripe Connect, y Connect es un
 * alta de PLATAFORMA que se habilita una sola vez en el panel de Stripe de quien
 * administra el sistema. Mientras no esté habilitada, cualquier intento de crear
 * la cuenta del dueño vuelve con:
 *
 *     "You can only create new accounts if you've signed up for Connect"
 *
 * ── QUÉ PASABA ANTES ────────────────────────────────────────────────────────
 * Eso llegaba al perfil del dueño convertido en tres carteles: uno amarillo en
 * el panel ("tenés autos publicados pero todavía no podés recibir la plata"),
 * otro en Ajustes ("todavía no podés cobrar") y un error al apretar el botón.
 *
 * Los tres eran ciertos y los tres eran inútiles, porque:
 *   · no hay plata real que cobrar en ningún caso, y
 *   · el único que podía resolverlo no era quien los leía.
 *
 * Alguien que entra a mostrar su cuenta veía una advertencia de dinero sobre
 * algo que nunca va a pasar. Eso no es prudencia, es ruido.
 *
 * ── QUÉ HACE AHORA ──────────────────────────────────────────────────────────
 * La transferencia al dueño se SIMULA, igual que el resto de la plata del
 * sistema: el libro contable registra el pago, la reserva queda liquidada, el
 * dueño ve su saldo moverse, y lo único que no ocurre es la llamada a Stripe
 * que hoy no puede ocurrir. No hay alta que completar, así que no hay cartel.
 *
 * Y NO SE MIENTE: el estado que devuelve el servidor lleva `simulated: true`, y
 * la pantalla lo dice con todas las letras ("los cobros están simulados"). Una
 * simulación anunciada es honesta; una que se hace pasar por un cobro real, no.
 *
 * ── CÓMO SE APAGA ───────────────────────────────────────────────────────────
 * Una variable de entorno, una sola:
 *
 *     STRIPE_CONNECT_ENABLED=true
 *
 * El día que se habilite Connect en el panel de Stripe se agrega esa variable y
 * todo vuelve al camino real sin tocar una línea de código. Mientras no esté,
 * se simula, que es lo que describe de verdad a este deploy.
 *
 * Por qué el valor por omisión es "simular" y no "cobrar de verdad": porque el
 * valor por omisión tiene que ser el que no rompe. Si está mal puesto en
 * "simular" cuando Connect sí anda, lo único que pasa es que las
 * transferencias quedan anotadas y no salen. Al revés —intentar una
 * transferencia real sin Connect— es exactamente el error que estamos sacando.
 */
import { ConfigService } from "@nestjs/config";

/**
 * El prefijo de una cuenta de cobro simulada.
 *
 * Es deliberadamente distinto de `acct_` (Stripe) y de `acct_mock_` (el
 * proveedor offline de los tests): los tres tienen que poder convivir en la
 * misma base sin que nadie confunda uno con otro. Una cuenta simulada nunca se
 * le manda a Stripe, porque Stripe contestaría "No such account".
 */
export const PREFIJO_CUENTA_SIMULADA = "acct_sim_";

/** El prefijo de una transferencia simulada, por el mismo motivo. */
export const PREFIJO_TRANSFERENCIA_SIMULADA = "tr_sim_";

/** Si este identificador salió de la simulación de cobros. */
export function esIdentificadorSimulado(
  id: string | null | undefined,
): boolean {
  return typeof id === "string" && id.includes("_sim_");
}

/**
 * ¿Hay que simular la transferencia al dueño?
 *
 * Solo "true" y "1" habilitan el camino real. Cualquier otra cosa —la variable
 * sin definir, vacía, mal escrita— simula, que es el lado que no rompe nada.
 */
export function hayQueSimularLosCobros(config: ConfigService): boolean {
  const valor = (config.get<string>("STRIPE_CONNECT_ENABLED") ?? "")
    .trim()
    .toLowerCase();
  return valor !== "true" && valor !== "1";
}

/**
 * La cuenta de cobro simulada de una persona. Es SIEMPRE LA MISMA para el mismo
 * usuario: si cambiara en cada llamada, cada transferencia iría a una cuenta
 * distinta y el registro no se podría leer.
 */
export function cuentaSimuladaDe(userId: string): string {
  return `${PREFIJO_CUENTA_SIMULADA}${userId.replace(/-/g, "").slice(0, 24)}`;
}

/**
 * El identificador de una transferencia simulada.
 *
 * Determinístico a propósito: la clave del asiento contable es
 * `payout:<id de la transferencia>`, así que un identificador que cambiara en
 * cada intento convertiría un reintento en un segundo pago. Con el mismo
 * dueño, la misma referencia y el mismo monto sale el mismo identificador, y el
 * libro lo rechaza por repetido, que es exactamente lo que tiene que pasar.
 */
export function transferenciaSimulada(
  ownerId: string,
  referencia: string,
  montoMinor: number,
): string {
  const limpio = `${ownerId}_${referencia}_${montoMinor}`.replace(
    /[^a-zA-Z0-9]+/g,
    "_",
  );
  return `${PREFIJO_TRANSFERENCIA_SIMULADA}${limpio}`;
}

/**
 * Lo que contesta GET /payments/connect/status cuando los cobros se simulan.
 *
 * `simulated: true` es el campo del que vive toda la pantalla: sin él, el front
 * tendría que deducir la simulación de que todo está en verde, y mostraría "ya
 * podés cobrar" como si la plata fuera a salir. Con él, dice lo que es.
 */
export function estadoSimulado(accountId: string) {
  return {
    connected: true,
    status: "ENABLED" as const,
    accountId,
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
    simulated: true,
  };
}
