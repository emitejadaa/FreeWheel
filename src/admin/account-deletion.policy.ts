import { ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * ¿Se pueden borrar cuentas de verdad, o solo darlas de baja?
 *
 * ── Las dos etapas del producto ─────────────────────────────────────────────
 * EN DESARROLLO borrar de verdad es lo que hace falta: se necesita reciclar los
 * mismos correos y los mismos teléfonos para armar cuentas de demostración una y
 * otra vez, y una cuenta "dada de baja" que se queda con el email tomado obliga
 * a inventar una dirección nueva cada vez.
 *
 * EN PRODUCCIÓN es exactamente al revés. Los datos de una cuenta NO tienen que
 * poder volver a usarse: quien fue expulsado por estafar no puede volver a
 * entrar registrándose de nuevo con el mismo DNI, el mismo teléfono y el mismo
 * correo. Mientras la fila del usuario siga existiendo, sus datos únicos quedan
 * tomados y esa puerta está cerrada; borrarla los libera y la abre. Además se
 * llevaría puesto lo que otras personas necesitan conservar —reservas, pagos,
 * reseñas y el registro de auditoría de un caso que quizás siga abierto—.
 * Para eso están SUSPENDED (baneada) y DELETED (dada de baja), que sacan a la
 * cuenta de circulación sin soltar sus datos.
 *
 * ── Cómo se decide ──────────────────────────────────────────────────────────
 * Por defecto: se puede borrar en todos lados MENOS en producción. O sea que la
 * protección se activa sola al pasar a producción, sin que nadie tenga que
 * acordarse de configurar nada — que es justo lo que no hay que dejar librado a
 * la memoria.
 *
 * ALLOW_ACCOUNT_HARD_DELETE fuerza la respuesta en cualquiera de los dos
 * sentidos, para el caso puntual: "true" habilita el borrado en un entorno de
 * demostración que corre con NODE_ENV=production, y "false" lo apaga en
 * desarrollo si se quiere probar cómo se comporta la API sin él.
 */
@Injectable()
export class AccountDeletionPolicy {
  constructor(private readonly config: ConfigService) {}

  /** El texto que ve un admin cuando el borrado está apagado. */
  static readonly BLOCKED_MESSAGE =
    "En producción las cuentas no se borran: se suspenden o se dan de baja, " +
    "así sus datos (email, teléfono, documento) quedan tomados y no se pueden " +
    "volver a usar para registrarse. Usá PATCH /admin/users/:id/status con " +
    "SUSPENDED (baneada) o DELETED (dada de baja).";

  get enabled(): boolean {
    const flag = (
      this.config.get<string>("ALLOW_ACCOUNT_HARD_DELETE") ?? ""
    ).toLowerCase();
    if (flag === "true") return true;
    if (flag === "false") return false;

    const env =
      this.config.get<string>("NODE_ENV") ??
      process.env.NODE_ENV ??
      "development";
    return env !== "production";
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
