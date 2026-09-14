/**
 * CATÁLOGO DE MOTIVOS DE LA VERIFICACIÓN DOCUMENTAL
 *
 * Cada motivo por el que un documento NO queda aprobado sale de acá, con un
 * código estable (para que el front ramifique) y un mensaje en castellano
 * listo para mostrarle al usuario.
 *
 * LA REGLA DE ESTE ARCHIVO: un motivo tiene que decirle a la persona QUÉ PASÓ
 * y QUÉ HACER. "Verificación fallida" no es un motivo; "la fecha de nacimiento
 * del documento no coincide con la de tu cuenta, corregila en tu perfil o
 * enviá el documento correcto" sí lo es. El usuario no ve el código, ve el
 * mensaje: si el mensaje no alcanza para saber cómo salir del problema, el
 * motivo está mal escrito.
 *
 * Los motivos se agrupan en cuatro familias:
 *
 *   · PRERREQUISITOS — falta algo antes de poder siquiera mirar el documento.
 *   · LECTURA — la máquina no pudo leer las fotos, o el servicio que las lee
 *     no estaba disponible. NUNCA rechazan: mandan a revisión manual, porque
 *     un problema nuestro no puede dejar trabada a una persona.
 *   · CRUCES — lo que dice el documento no cierra: consigo mismo (señal de
 *     adulteración) o con los datos de la cuenta.
 *   · HABILITACIÓN — el documento es válido pero no habilita a manejar: está
 *     vencido, es de otra clase, o la licencia todavía es de principiante.
 *
 * Las filas viejas guardan el motivo completo (código + mensaje) dentro de
 * `matchReport`, así que se siguen mostrando aunque su código ya no esté acá.
 */

export type VerificationReasonCode =
  // ── Prerrequisitos ──────────────────────────────────────────────────────
  | "PERFIL_INCOMPLETO"
  // ── Antifraude ──────────────────────────────────────────────────────────
  | "DOCUMENTO_YA_VERIFICADO"
  // ── Revisión manual ─────────────────────────────────────────────────────
  | "RECHAZADO_POR_ADMIN"
  // ── Lectura automática ──────────────────────────────────────────────────
  | "LECTURA_NO_DISPONIBLE"
  | "LECTURA_FALLIDA"
  | "DATO_ILEGIBLE"
  // ── Cruces ──────────────────────────────────────────────────────────────
  | "DATO_NO_COINCIDE_ENTRE_ORIGENES"
  | "DATO_NO_COINCIDE_CON_LA_CUENTA"
  | "LICENCIA_NO_ES_DEL_TITULAR"
  | "CUIL_NO_CORRESPONDE_AL_DNI"
  | "DOCUMENTO_NO_ES_ARGENTINO"
  // ── Habilitación ────────────────────────────────────────────────────────
  | "DOCUMENTO_VENCIDO"
  | "LICENCIA_VENCIDA"
  | "LICENCIA_CLASE_NO_HABILITA"
  | "LICENCIA_PRINCIPIANTE"
  | "DNI_VENCIDO";

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
  /** Cómo se llama el dato en castellano ("tu fecha de nacimiento"). */
  label?: string;
  /** Lo que dicen las distintas lecturas del documento. */
  values?: string[];
  /** Fecha relevante (vencimiento, fin del período de principiante). */
  date?: string;
}

/** El dato con el nombre que usaría una persona, no el del JSON. */
export const FIELD_LABELS: Record<string, string> = {
  apellido: "el apellido",
  nombre: "el nombre",
  numero_documento: "el número de DNI",
  fecha_nacimiento: "la fecha de nacimiento",
  cuil: "el CUIL",
  numero_licencia: "el número de licencia",
  sexo: "el sexo",
  fecha_vencimiento: "la fecha de vencimiento",
  clase: "la clase de licencia",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? `el dato "${field}"`;
}

const CATALOG: Record<VerificationReasonCode, (ctx: ReasonContext) => string> =
  {
    PERFIL_INCOMPLETO: (c) =>
      "Antes de verificar tus documentos completá los datos de tu cuenta: " +
      `${(c.missing ?? []).join(", ")}. Los documentos se comparan contra ` +
      "esos datos.",

    DOCUMENTO_YA_VERIFICADO: () =>
      "Este documento ya está verificado en otra cuenta. Una misma identidad " +
      "no puede verificar dos cuentas. Si creés que es un error, contactá a " +
      "un administrador.",

    RECHAZADO_POR_ADMIN: () =>
      "Un administrador revisó tu documentación y la rechazó. Podés volver a " +
      "enviar fotos de un documento válido.",

    // ── Lectura ───────────────────────────────────────────────────────────
    // Estos tres no son culpa del usuario, y el mensaje lo dice: la salida es
    // que lo mire un admin, no que vuelva a intentar diez veces.
    LECTURA_NO_DISPONIBLE: () =>
      "No pudimos revisar tus documentos automáticamente en este momento. Ya " +
      "quedaron guardados y un administrador los va a revisar: no hace falta " +
      "que los vuelvas a enviar.",

    LECTURA_FALLIDA: (c) =>
      "No pudimos leer tus documentos automáticamente" +
      (c.detail ? ` (${c.detail})` : "") +
      ". Un administrador los va a revisar a mano. Si querés acelerarlo, " +
      "podés reenviar fotos más nítidas, con el documento entero dentro de la " +
      "foto y sin reflejos encima.",

    DATO_ILEGIBLE: (c) =>
      `No pudimos leer ${c.label ?? "un dato"} en las fotos que enviaste. ` +
      "Sacá la foto con buena luz, con el documento entero dentro del cuadro " +
      "y sin brillos sobre el texto, o esperá a que un administrador la revise.",

    // ── Cruces ────────────────────────────────────────────────────────────
    DATO_NO_COINCIDE_ENTRE_ORIGENES: (c) =>
      `En tu documento, ${c.label ?? "un dato"} no dice lo mismo en todas ` +
      "partes" +
      (c.values?.length ? ` (leímos ${c.values.join(" y ")})` : "") +
      ". Puede ser un problema de la foto o del documento. Un administrador " +
      "lo va a revisar.",

    DATO_NO_COINCIDE_CON_LA_CUENTA: (c) =>
      `${capitalizar(c.label ?? "un dato")} de tu documento no coincide con ` +
      "el de tu cuenta" +
      (c.values?.length ? ` (el documento dice ${c.values.join(" / ")})` : "") +
      ". Corregí tus datos en el perfil o enviá el documento correcto.",

    LICENCIA_NO_ES_DEL_TITULAR: () =>
      "El número de tu licencia no coincide con tu número de DNI. En " +
      "Argentina la licencia lleva el mismo número que el DNI, así que las " +
      "fotos podrían ser de documentos de personas distintas. Un " +
      "administrador lo va a revisar.",

    CUIL_NO_CORRESPONDE_AL_DNI: () =>
      "El CUIL de tu documento no corresponde a tu número de DNI. Revisá los " +
      "datos de tu cuenta o enviá el documento correcto.",

    DOCUMENTO_NO_ES_ARGENTINO: () =>
      "El documento que enviaste no figura como un DNI argentino. Por ahora " +
      "solo podemos verificar DNI y licencia nacional de conducir argentinos.",

    // ── Habilitación ──────────────────────────────────────────────────────
    DOCUMENTO_VENCIDO: (c) =>
      "El documento que enviaste está vencido" +
      (c.date ? ` (venció el ${formatearFecha(c.date)})` : "") +
      ". Enviá uno vigente.",

    LICENCIA_VENCIDA: (c) =>
      "Tu licencia de conducir está vencida" +
      (c.date ? ` desde el ${formatearFecha(c.date)}` : "") +
      ". No podés alquilar un auto hasta que subas una licencia vigente.",

    LICENCIA_CLASE_NO_HABILITA: (c) =>
      `Tu licencia es clase ${c.detail ?? "desconocida"}, que no habilita a ` +
      "conducir autos particulares. Para alquilar necesitás una licencia " +
      "clase B (o C, D o E, que la incluyen).",

    LICENCIA_PRINCIPIANTE: (c) =>
      "Tu licencia todavía está en período de principiante" +
      (c.date ? `, hasta el ${formatearFecha(c.date)}` : "") +
      ". Durante ese período no podés alquilar un auto: el seguro de los " +
      "vehículos no cubre a conductores principiantes.",

    DNI_VENCIDO: (c) =>
      "Tu DNI venció" +
      (c.date ? ` el ${formatearFecha(c.date)}` : "") +
      ". Renovalo y volvé a enviarlo para mantener tu cuenta verificada.",
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

/**
 * "el apellido" → "El apellido". Los labels se escriben en minúscula porque
 * casi siempre caen en medio de una oración; cuando uno arranca el mensaje,
 * hay que levantarle la primera letra.
 */
function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/**
 * Una fecha ISO como la escribiría una persona: "2024-03-07" → "7/3/2024".
 *
 * A mano y no con toLocaleDateString porque esto corre en un servidor cuya
 * zona horaria no es la del usuario: `new Date("2024-03-07")` se interpreta a
 * medianoche UTC, y formateado en cualquier zona al oeste de Greenwich —la
 * nuestra— retrocede un día. El mensaje diría que la licencia venció el 6
 * cuando venció el 7.
 */
function formatearFecha(iso: string): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!partes) return iso;
  const [, anio, mes, dia] = partes;
  return `${Number(dia)}/${Number(mes)}/${anio}`;
}
