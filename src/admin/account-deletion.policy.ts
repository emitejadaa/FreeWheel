import { ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * ¿Se pueden borrar cuentas de verdad, o solo darlas de baja?
 *
 * ── SON DOS ACCIONES DISTINTAS, Y LAS DOS TIENEN QUE EXISTIR ────────────────
 * SUSPENDER / DAR DE BAJA saca a la cuenta de circulación pero la deja
 * existiendo: su email, su teléfono y su documento quedan TOMADOS, así que quien
 * fue expulsado por estafar no puede volver a entrar registrándose con los
 * mismos datos. Ese es el castigo, y sigue siendo el camino normal.
 *
 * BORRAR es otra cosa: la cuenta deja de existir y sus datos quedan LIBRES. Hace
 * falta para dos casos legítimos que no se pueden resolver con lo anterior:
 *
 *   1. Reciclar cuentas de prueba. Sin esto, cada vuelta de prueba del registro
 *      quema un correo para siempre y hay que inventar direcciones nuevas.
 *   2. Que alguien pida que se borren sus datos, y que se borren de verdad.
 *
 * ── POR QUÉ ESTO CAMBIÓ ─────────────────────────────────────────────────────
 * Antes el borrado estaba APAGADO en producción salvo que alguien pusiera una
 * variable de entorno. La intención era buena —que nadie borre por error lo que
 * quiso suspender— pero el efecto real era otro: la única instalación que
 * existe corre con NODE_ENV=production, así que el botón de borrar no aparecía
 * en ninguna parte y las dos acciones legítimas de arriba no se podían hacer.
 * Una protección que apaga la función entera en el único lugar donde se usa no
 * está protegiendo: está rompiendo.
 *
 * Y la protección contra el borrado por error no vive acá: vive en el panel, que
 * muestra las dos acciones con nombres distintos, explica en qué se diferencian,
 * y para borrar EXIGE ESCRIBIR EL EMAIL de la cuenta. Es la misma barrera que
 * usa GitHub para borrar un repositorio, y es una barrera que se aplica en el
 * momento y contra la cuenta concreta, no una que apaga el botón para siempre.
 *
 * ── Cómo se decide ──────────────────────────────────────────────────────────
 * Por defecto está HABILITADO. ALLOW_ACCOUNT_HARD_DELETE="false" lo apaga, para
 * una instalación donde se decida que las cuentas no se borran nunca; "true" lo
 * fuerza. Cualquier otro valor no cambia nada.
 */
@Injectable()
export class AccountDeletionPolicy {
  constructor(private readonly config: ConfigService) {}

  /** El texto que ve un admin cuando el borrado está apagado. */
  static readonly BLOCKED_MESSAGE =
    "Este servidor tiene apagado el borrado de cuentas " +
    "(ALLOW_ACCOUNT_HARD_DELETE=false). Las cuentas se suspenden o se dan de " +
    "baja: así sus datos (email, teléfono, documento) quedan tomados y no se " +
    "pueden volver a usar para registrarse. Usá PATCH /admin/users/:id/status " +
    "con SUSPENDED (baneada) o DELETED (dada de baja).";

  get enabled(): boolean {
    const flag = (
      this.config.get<string>("ALLOW_ACCOUNT_HARD_DELETE") ?? ""
    ).toLowerCase();
    // Solo un "false" explícito apaga el borrado. Ver el comentario de arriba:
    // la barrera contra el borrado por error es escribir el email en el panel,
    // no apagar la función en el único entorno que existe.
    return flag !== "false";
  }

  /** Corta el pedido si el borrado definitivo no está habilitado. */
  assertAllowed(): void {
    if (this.enabled) return;

    throw new ForbiddenException({
      statusCode: 403,
      code: "ACCOUNT_HARD_DELETE_DISABLED",
      message: AccountDeletionPolicy.BLOCKED_MESSAGE,
    });
  }
}
