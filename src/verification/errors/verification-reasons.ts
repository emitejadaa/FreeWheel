import type { DocumentSlot } from "../identity/document-slots";

/**
 * CATÁLOGO DE MOTIVOS DE LA VERIFICACIÓN DOCUMENTAL
 *
 * Todo lo que puede salir mal al verificar un documento sale de acá, y cada
 * motivo trae tres cosas que el front necesita por separado:
 *
 *   · `code`   — estable, en MAYÚSCULAS_CON_GUIONES. Es contra esto que el
 *                front ramifica; el texto puede cambiar, el código no.
 *   · `action` — qué puede hacer la persona para salir. Es lo que decide qué
 *                botón se muestra: repetir una foto no es lo mismo que
 *                corregir un dato, y ninguna de las dos es esperar a un admin.
 *   · `slots`  — QUÉ FOTOS están involucradas ("dni_front", "license_back").
 *                Es lo que permite decir "sacá de nuevo el dorso, el frente
 *                está bien" en vez de mandar a repetir las dos.
 *
 * El `message` viene armado en castellano y listo para mostrar, pero es un
 * respaldo: el front tiene con el código y la acción todo lo que hace falta
 * para escribir el suyo.
 *
 * LA REGLA DE ESTE ARCHIVO: un motivo tiene que decir QUÉ PASÓ y QUÉ HACER.
 * "Verificación fallida" no es un motivo; "la fecha de vencimiento que cargaste
 * no es la que dice la licencia" sí lo es.
 *
 * Las familias:
 *
 *   · PRERREQUISITOS — falta un dato antes de poder mirar el documento.
 *   · LECTURA — no se pudo leer. Si el problema es de la foto, se repite la
 *     foto; si el problema es nuestro (servicio caído), NO cuenta como
 *     documento fallado y lo mira un admin.
 *   · CRUCES — lo que dice el documento no cierra: consigo mismo (señal de
 *     adulteración) o contra lo que la persona declaró.
 *   · HABILITACIÓN — el documento es auténtico pero no habilita: está vencido,
 *     es de otra clase, o la licencia todavía es de principiante. NO impiden
 *     aprobar el documento; impiden usar la cuenta para ciertas cosas.
 *
 * Las filas viejas guardan el motivo completo (código + mensaje) dentro de
 * `matchReport`, así que se siguen mostrando aunque su código ya no esté acá.
 */

export type VerificationReasonCode =
  // ── Prerrequisitos ──────────────────────────────────────────────────────
  | "PERFIL_INCOMPLETO"
  | "DATOS_DEL_DOCUMENTO_FALTANTES"
  // ── Antifraude ──────────────────────────────────────────────────────────
  | "DOCUMENTO_YA_VERIFICADO"
  // ── Revisión manual ─────────────────────────────────────────────────────
  | "RECHAZADO_POR_ADMIN"
  // ── Lectura automática ──────────────────────────────────────────────────
  | "LECTURA_NO_DISPONIBLE"
  | "LECTURA_FALLIDA"
  | "FOTO_ILEGIBLE"
  | "DATO_ILEGIBLE"
  // ── Cruces ──────────────────────────────────────────────────────────────
  | "DATO_NO_COINCIDE_ENTRE_ORIGENES"
  | "DATO_NO_COINCIDE_CON_LA_CUENTA"
  | "DATO_NO_COINCIDE_CON_LO_DECLARADO"
  | "LICENCIA_NO_ES_DEL_TITULAR"
  | "CUIL_NO_CORRESPONDE_AL_DNI"
  | "DOCUMENTO_NO_ES_ARGENTINO"
  // ── Habilitación ────────────────────────────────────────────────────────
  | "LICENCIA_VENCIDA"
  | "LICENCIA_CLASE_NO_HABILITA"
  | "LICENCIA_PRINCIPIANTE"
  | "DNI_VENCIDO";

/**
 * Qué puede hacer la persona para salir de este motivo. Es lo que el front
 * traduce en un botón.
 *
 *   RETAKE_PHOTO       — repetir las fotos de `slots`. El resto sirven.
 *   FIX_DECLARED_DATA  — corregir lo que cargó sobre ESTE documento
 *                        (vencimiento, clase, otorgamiento) y reenviarlo.
 *   FIX_PROFILE        — corregir los datos de la cuenta (nombre, DNI, CUIL,
 *                        fecha de nacimiento) y reenviar el documento.
 *   USE_VALID_DOCUMENT — el documento es de otro tipo, de otro país o está
 *                        vencido: hace falta otro documento, no otra foto.
 *   REQUEST_REVIEW     — no lo puede resolver solo; que lo mire un admin.
 *   CONTACT_SUPPORT    — hace falta que intervenga alguien de la plataforma.
 *   WAIT               — no hizo nada mal; el problema es nuestro y ya está en
 *                        camino de resolverse.
 */
export type ReasonAction =
  | "RETAKE_PHOTO"
  | "FIX_DECLARED_DATA"
  | "FIX_PROFILE"
  | "USE_VALID_DOCUMENT"
  | "REQUEST_REVIEW"
  | "CONTACT_SUPPORT"
  | "WAIT";

export interface VerificationReason {
  code: VerificationReasonCode;
  /** Explicación en castellano, apta para mostrar tal cual. */
  message: string;
  /** Qué puede hacer la persona para salir de este motivo. */
  action: ReasonAction;
  /** Campo del vocabulario compartido al que refiere, si aplica. */
  field?: string;
  /**
   * Las fotos involucradas. Vacío cuando el motivo no es de una foto
   * (un dato del perfil mal cargado, el servicio de lectura caído).
   */
  slots: DocumentSlot[];
  /**
   * La primera de `slots`. Está por compatibilidad: el front viejo lee `slot`
   * y espera un string suelto. Nuevo código: usar `slots`.
   */
  slot?: DocumentSlot;
}

export interface ReasonContext {
  field?: string;
  slots?: DocumentSlot[];
  /** Nombres de campos que faltan (PERFIL_INCOMPLETO / DATOS_FALTANTES). */
  missing?: string[];
  /** Detalle extra ya apto para el usuario. */
  detail?: string;
  /** Cómo se llama el dato en castellano ("tu fecha de nacimiento"). */
  label?: string;
  /** Cuántas lecturas distintas aparecieron (sin decir cuáles: son datos). */
  sources?: number;
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
  fecha_otorgamiento: "la fecha de otorgamiento",
  clase: "la clase de licencia",
  es_principiante: "el período de principiante",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? `el dato "${field}"`;
}

interface CatalogEntry {
  action: ReasonAction;
  message: (ctx: ReasonContext) => string;
}

const CATALOG: Record<VerificationReasonCode, CatalogEntry> = {
  // ── Prerrequisitos ────────────────────────────────────────────────────
  PERFIL_INCOMPLETO: {
    action: "FIX_PROFILE",
    message: (c) =>
      "Antes de verificar tus documentos completá los datos de tu cuenta: " +
      `${(c.missing ?? []).join(", ")}. Los documentos se comparan contra ` +
      "esos datos.",
  },

  DATOS_DEL_DOCUMENTO_FALTANTES: {
    action: "FIX_DECLARED_DATA",
    message: (c) =>
      "Faltan datos de este documento: " +
      `${(c.missing ?? []).join(", ")}. Cargalos leyéndolos del documento ` +
      "que estás por enviar: son los que después definen qué podés hacer en " +
      "la plataforma.",
  },

  // ── Antifraude ────────────────────────────────────────────────────────
  DOCUMENTO_YA_VERIFICADO: {
    action: "CONTACT_SUPPORT",
    message: () =>
      "Este documento ya está verificado en otra cuenta. Una misma identidad " +
      "no puede verificar dos cuentas. Si creés que es un error, contactá a " +
      "un administrador.",
  },

  RECHAZADO_POR_ADMIN: {
    action: "RETAKE_PHOTO",
    message: () =>
      "Un administrador revisó tu documentación y la rechazó. Podés volver a " +
      "enviar fotos de un documento válido.",
  },

  // ── Lectura ───────────────────────────────────────────────────────────
  // Los dos primeros no son culpa del usuario, y el mensaje lo dice: la salida
  // es que lo mire un admin, no que vuelva a intentar diez veces. Tampoco
  // cuentan como documento fallado.
  LECTURA_NO_DISPONIBLE: {
    action: "WAIT",
    message: () =>
      "No pudimos revisar tus documentos automáticamente en este momento. Ya " +
      "quedaron guardados y un administrador los va a revisar: no hace falta " +
      "que los vuelvas a enviar.",
  },

  // NO lleva el consejo de "reenviá fotos mejores", y es deliberado: este
  // motivo significa que nuestro servicio de lectura no pudo ser consultado
  // —estaba caído, no llegamos, el deploy está mal configurado—, y ninguna de
  // esas cosas se arregla con una foto más nítida. El consejo sobre las fotos
  // vive en FOTO_ILEGIBLE y DATO_ILEGIBLE, que son los motivos que sí hablan
  // de la foto.
  LECTURA_FALLIDA: {
    action: "WAIT",
    message: (c) =>
      "No pudimos leer tus documentos automáticamente" +
      (c.detail ? ` (${c.detail})` : "") +
      ". No es un problema de tus fotos y no hace falta que las vuelvas a " +
      "enviar: ya quedaron guardadas y un administrador las va a revisar.",
  },

  FOTO_ILEGIBLE: {
    action: "RETAKE_PHOTO",
    message: () =>
      "No pudimos leer nada en esta foto. Sacala con buena luz, con el " +
      "documento entero dentro del cuadro, apoyado sobre una superficie lisa " +
      "y sin brillos sobre el texto.",
  },

  DATO_ILEGIBLE: {
    action: "RETAKE_PHOTO",
    message: (c) =>
      `No pudimos leer ${c.label ?? "un dato"} en esta foto. Sacala con ` +
      "buena luz, con el documento entero dentro del cuadro y sin brillos " +
      "sobre el texto.",
  },

  // ── Cruces ────────────────────────────────────────────────────────────
  DATO_NO_COINCIDE_ENTRE_ORIGENES: {
    // No se le pide que arregle nada: que lo impreso y el código de barras
    // digan cosas distintas es la firma de una tarjeta adulterada, y esa
    // decisión no la puede tomar un OCR ni la persona que trajo el documento.
    action: "REQUEST_REVIEW",
    message: (c) =>
      `En tu documento, ${c.label ?? "un dato"} no dice lo mismo en el texto ` +
      "impreso que en el código. Puede ser un problema de la foto o del " +
      "documento. Pedí que lo revise un administrador.",
  },

  DATO_NO_COINCIDE_CON_LA_CUENTA: {
    action: "FIX_PROFILE",
    message: (c) =>
      `${capitalizar(c.label ?? "un dato")} de tu documento no coincide con ` +
      "el de tu cuenta. Corregí tus datos en el perfil y volvé a enviar el " +
      "documento, o enviá el documento correcto.",
  },

  DATO_NO_COINCIDE_CON_LO_DECLARADO: {
    action: "FIX_DECLARED_DATA",
    message: (c) =>
      `${capitalizar(c.label ?? "un dato")} que cargaste no es la que dice ` +
      "el documento. Corregila mirando el documento y volvé a enviarlo.",
  },

  LICENCIA_NO_ES_DEL_TITULAR: {
    action: "REQUEST_REVIEW",
    message: () =>
      "El número de tu licencia no coincide con tu número de DNI. En " +
      "Argentina la licencia lleva el mismo número que el DNI, así que las " +
      "fotos podrían ser de documentos de personas distintas. Pedí que lo " +
      "revise un administrador.",
  },

  CUIL_NO_CORRESPONDE_AL_DNI: {
    action: "FIX_PROFILE",
    message: () =>
      "El CUIL de tu documento no corresponde a tu número de DNI. Revisá los " +
      "datos de tu cuenta o enviá el documento correcto.",
  },

  DOCUMENTO_NO_ES_ARGENTINO: {
    action: "USE_VALID_DOCUMENT",
    message: () =>
      "El documento que enviaste no figura como un DNI argentino. Por ahora " +
      "solo podemos verificar DNI y licencia nacional de conducir argentinos.",
  },

  // ── Habilitación ──────────────────────────────────────────────────────
  // Ninguno de estos impide aprobar el documento: son auténticos y son de
  // quien dice ser. Lo que impiden es usar la cuenta para ciertas cosas, y eso
  // se resuelve en la capa de habilitación (driving-eligibility.ts y
  // VerifiedAccountGuard), no negando la verificación.
  LICENCIA_VENCIDA: {
    action: "USE_VALID_DOCUMENT",
    message: (c) =>
      "Tu licencia de conducir está vencida" +
      (c.date ? ` desde el ${formatearFecha(c.date)}` : "") +
      ". Tu cuenta sigue verificada, pero no podés alquilar un auto hasta " +
      "que subas una licencia vigente.",
  },

  LICENCIA_CLASE_NO_HABILITA: {
    action: "USE_VALID_DOCUMENT",
    message: (c) =>
      `Tu licencia es clase ${c.detail ?? "desconocida"}, que no habilita a ` +
      "conducir autos particulares. Para alquilar necesitás una licencia " +
      "clase B (o C, D o E, que la incluyen).",
  },

  LICENCIA_PRINCIPIANTE: {
    action: "USE_VALID_DOCUMENT",
    message: (c) =>
      "Tu licencia todavía está en período de principiante" +
      (c.date ? `, hasta el ${formatearFecha(c.date)}` : "") +
      ". Durante ese período no podés alquilar un auto: el seguro de los " +
      "vehículos no cubre a conductores principiantes.",
  },

  DNI_VENCIDO: {
    action: "USE_VALID_DOCUMENT",
    message: (c) =>
      "Tu DNI venció" +
      (c.date ? ` el ${formatearFecha(c.date)}` : "") +
      ". Tu cuenta sigue verificada, pero no vas a poder reservar, publicar " +
      "ni cobrar hasta que renueves el documento y lo vuelvas a enviar.",
  },
};

/** Arma un motivo del catálogo. Única forma de crear un VerificationReason. */
export function verificationReason(
  code: VerificationReasonCode,
  context: ReasonContext = {},
): VerificationReason {
  const entry = CATALOG[code];
  const slots = context.slots ?? [];
  return {
    code,
    message: entry.message(context),
    action: entry.action,
    slots,
    ...(context.field ? { field: context.field } : {}),
    ...(slots.length > 0 ? { slot: slots[0] } : {}),
  };
}

export const VERIFICATION_REASON_CODES = Object.keys(
  CATALOG,
) as VerificationReasonCode[];

/** La acción que le corresponde a un código, sin armar el motivo entero. */
export function reasonAction(code: VerificationReasonCode): ReasonAction {
  return CATALOG[code].action;
}

/**
 * Motivos que se anotan pero NO impiden aprobar el documento.
 *
 * La distinción es entre "este documento no es confiable" y "este documento es
 * tuyo pero no te habilita". Una licencia vencida es genuinamente tu licencia:
 * verificar tu identidad con ella está bien, y lo que corresponde es aprobarla
 * y después no dejarte alquilar un auto, con el motivo a la vista. Negar la
 * verificación por eso dejaba a la persona sin cuenta Y sin poder manejar,
 * cuando el problema era uno solo.
 *
 * Es la misma lista que mira el veredicto automático y la que decide qué
 * motivos se conservan en un documento aprobado.
 */
export const NO_IMPIDEN_APROBAR = new Set<VerificationReasonCode>([
  "LICENCIA_VENCIDA",
  "LICENCIA_CLASE_NO_HABILITA",
  "LICENCIA_PRINCIPIANTE",
  "DNI_VENCIDO",
]);

/**
 * Motivos que son un problema NUESTRO y no del documento.
 *
 * No cuentan como documento fallado: la fila queda PENDING esperando a un
 * admin, con el motivo guardado aparte. Que nuestro servicio de lectura esté
 * caído no puede aparecerle a una persona como "tu documento falló".
 */
export const PROBLEMAS_NUESTROS = new Set<VerificationReasonCode>([
  "LECTURA_NO_DISPONIBLE",
  "LECTURA_FALLIDA",
]);

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
