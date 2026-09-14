/**
 * CATÁLOGO DE MOTIVOS DE LA VERIFICACIÓN DOCUMENTAL
 *
 * Cada motivo por el que un documento NO queda aprobado sale de acá, con un
 * código estable (para que el front ramifique) y un mensaje en castellano
 * listo para mostrarle al usuario.
 *
 * Son pocos porque este backend no analiza las fotos: las guarda y un admin
 * las revisa. Los motivos de "no pudimos leer tal campo" pertenecían a la
 * verificación automática vieja y se fueron con ella; la lectura de
 * documentos ahora vive en un servicio aparte (docverify-api/), que devuelve
 * sus propios errores y no escribe en esta base.
 *
 * Las filas viejas guardan el motivo completo (código + mensaje) dentro de
 * `matchReport`, así que se siguen mostrando aunque su código ya no esté acá.
 */

export type VerificationReasonCode =
  // Prerrequisitos
  | "PERFIL_INCOMPLETO"
  // Antifraude
  | "DOCUMENTO_YA_VERIFICADO"
  // Revisión manual
  | "RECHAZADO_POR_ADMIN";

export interface VerificationReason {
  code: VerificationReasonCode;
  /** Explicación en castellano, apta para mostrar tal cual. */
  message: string;
  /** Campo del vocabulario compartido al que refiere, si aplica. */
  field?: string;
  /** Foto a la que refiere ("dni_front", "license_back"...), si aplica. */
  slot?: string;
}

export interface ReasonContext {
  field?: string;
  slot?: string;
  /** Nombres de campos del perfil que faltan (PERFIL_INCOMPLETO). */
  missing?: string[];
  /** Detalle extra ya apto para el usuario. */
  detail?: string;
}

const CATALOG: Record<VerificationReasonCode, (ctx: ReasonContext) => string> =
  {
    PERFIL_INCOMPLETO: (c) =>
      "Antes de verificar tus documentos completá los datos de tu cuenta: " +
      `${(c.missing ?? []).join(", ")}. El administrador compara los ` +
      "documentos contra esos datos.",

    DOCUMENTO_YA_VERIFICADO: () =>
      "Este documento ya está verificado en otra cuenta. Una misma identidad " +
      "no puede verificar dos cuentas. Si creés que es un error, contactá a " +
      "un administrador.",

    RECHAZADO_POR_ADMIN: () =>
      "Un administrador revisó tu documentación y la rechazó. Podés volver a " +
      "enviar fotos de un documento válido.",
  };

/** Arma un motivo del catálogo. Única forma de crear un VerificationReason. */
export function verificationReason(
  code: VerificationReasonCode,
  context: ReasonContext = {},
): VerificationReason {
  return {
    code,
    message: CATALOG[code](context),
    ...(context.field ? { field: context.field } : {}),
    ...(context.slot ? { slot: context.slot } : {}),
  };
}

export const VERIFICATION_REASON_CODES = Object.keys(
  CATALOG,
) as VerificationReasonCode[];
