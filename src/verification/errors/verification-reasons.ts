/**
 * CATÁLOGO DE MOTIVOS DE LA VERIFICACIÓN DOCUMENTAL
 *
 * Cada motivo por el que un documento NO se aprueba automáticamente sale de
 * acá, con un código estable (para que el front ramifique) y un mensaje en
 * castellano listo para mostrarle al usuario. La regla de privacidad: los
 * mensajes dicen QUÉ dato falló y DÓNDE, nunca el valor leído — los valores
 * quedan en `extracted`/`matchReport`, que solo ven los admins.
 *
 * Ante cualquiera de estos motivos el usuario tiene dos salidas, y el
 * mensaje debe dejarlas claras: volver a enviar fotos más nítidas, o pedir
 * que un administrador revise el caso a mano.
 */

export type VerificationReasonCode =
  // Prerrequisitos
  | "PERFIL_INCOMPLETO"
  // La foto o el verificador
  | "FOTO_NO_PROCESABLE"
  | "VERIFICACION_NO_DISPONIBLE"
  // Protocolos ancla del DNI
  | "CODIGO_NO_LEIDO"
  | "MRZ_NO_LEIDO"
  // Campos
  | "CAMPO_ILEGIBLE"
  | "CAMPO_NO_COINCIDE"
  | "DOMICILIO_ILEGIBLE"
  | "DOMICILIO_NO_COINCIDE"
  // Reglas del documento
  | "DNI_VENCIDO"
  | "LICENCIA_VENCIDA"
  | "MENOR_DE_EDAD"
  | "PRINCIPIANTE_VIGENTE"
  | "PRINCIPIANTE_NO_DETERMINADO"
  | "LICENCIA_NO_CORRESPONDE_AL_DNI"
  | "CUIL_NO_CORRESPONDE_AL_DNI"
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
  /** Fecha en juego (vencimientos, fin de principiante), ISO AAAA-MM-DD. */
  date?: string;
  /** Detalle extra ya apto para el usuario. */
  detail?: string;
}

const SLOT_LABEL: Record<string, string> = {
  dni_front: "el frente del DNI",
  dni_back: "el dorso del DNI",
  license_front: "el frente de la licencia",
  license_back: "el dorso de la licencia",
};

const FIELD_LABEL: Record<string, string> = {
  apellido: "el apellido",
  nombre: "el nombre",
  sexo: "el sexo",
  nDocumento: "el número de documento",
  fechaNacimiento: "la fecha de nacimiento",
  fechaEmision: "la fecha de emisión",
  fechaVencimiento: "la fecha de vencimiento",
  domicilio: "el domicilio",
  cuil: "el CUIL",
  numLicencia: "el número de licencia",
  esPrincipiante: "la condición de principiante",
  finPrincipiante: "la fecha de fin de principiante",
};

function slotLabel(slot?: string): string {
  return (slot && SLOT_LABEL[slot]) || "la foto";
}

function fieldLabel(field?: string): string {
  return (field && FIELD_LABEL[field]) || "un dato";
}

const RETRY_HINT =
  "Podés volver a enviar fotos más nítidas (bien iluminadas, sin reflejos y " +
  "con el documento entero) o pedir que un administrador revise tu caso.";

const CATALOG: Record<VerificationReasonCode, (ctx: ReasonContext) => string> =
  {
    PERFIL_INCOMPLETO: (c) =>
      "Antes de verificar tus documentos completá los datos de tu cuenta: " +
      `${(c.missing ?? []).join(", ")}. Los documentos se comparan contra esos datos.`,

    FOTO_NO_PROCESABLE: (c) =>
      `No pudimos procesar la foto de ${slotLabel(c.slot)}` +
      `${c.detail ? ` (${c.detail})` : ""}. ${RETRY_HINT}`,

    // `detail` dice POR QUÉ no se pudo (falta Python, falta el storage, el
    // verificador remoto no contestó). Es información de servidor, no del
    // documento de la persona, así que se puede mostrar sin filtrar nada de
    // ella — y sin eso el diagnóstico era adivinar.
    //
    // "en este servidor" y no "en este momento": cuando falta el verificador no
    // es algo pasajero que se arregle reintentando, es que ESTE servidor no
    // tiene con qué. Decir "en este momento" manda a la persona a reintentar
    // para siempre.
    VERIFICACION_NO_DISPONIBLE: (c) =>
      "La verificación automática no está disponible en este servidor" +
      `${c.detail ? `: ${c.detail}` : ""}. ` +
      "Podés reintentar más tarde o pedir que un administrador revise tu caso.",

    CODIGO_NO_LEIDO: () =>
      "No pudimos leer el código de barras del frente del DNI. Tiene que " +
      "entrar entero en la foto, enfocado y sin reflejos. " +
      RETRY_HINT,

    MRZ_NO_LEIDO: () =>
      "No pudimos leer las tres líneas de letras y símbolos < del pie del " +
      "dorso del DNI. Tienen que verse completas y nítidas. " +
      RETRY_HINT,

    CAMPO_ILEGIBLE: (c) =>
      `No pudimos leer ${fieldLabel(c.field)} en ${slotLabel(c.slot)}. ` +
      RETRY_HINT,

    CAMPO_NO_COINCIDE: (c) =>
      `${capitalize(fieldLabel(c.field))} no coincide entre ` +
      `${c.detail ?? "lo que dice el documento y los datos de tu cuenta"}. ` +
      "Revisá los datos cargados en tu cuenta; si el documento es correcto, " +
      "pedí la revisión de un administrador.",

    DOMICILIO_ILEGIBLE: () =>
      "No pudimos leer el domicilio impreso en el documento. " + RETRY_HINT,

    DOMICILIO_NO_COINCIDE: () =>
      "El domicilio del documento no se parece al cargado en tu cuenta. El " +
      "domicilio impreso varía mucho entre documentos, así que puede ser solo " +
      "un problema de formato: revisá el de tu cuenta o pedí la revisión de " +
      "un administrador.",

    DNI_VENCIDO: (c) =>
      `El DNI está vencido${c.date ? ` (venció el ${c.date})` : ""}. ` +
      "Necesitás un documento vigente para operar en la plataforma.",

    LICENCIA_VENCIDA: (c) =>
      `La licencia de conducir está vencida${c.date ? ` (venció el ${c.date})` : ""}. ` +
      "Necesitás una licencia vigente para operar en la plataforma.",

    MENOR_DE_EDAD: () =>
      "Según el documento todavía no cumpliste 18 años. La plataforma solo " +
      "permite operar a personas mayores de edad.",

    PRINCIPIANTE_VIGENTE: (c) =>
      "Tu licencia todavía está en período de principiante" +
      `${c.date ? ` (hasta el ${c.date})` : ""}. Vas a poder verificarla ` +
      "cuando ese período termine.",

    PRINCIPIANTE_NO_DETERMINADO: () =>
      "La licencia dice PRINCIPIANTE pero no pudimos leer hasta cuándo. " +
      RETRY_HINT,

    CUIL_NO_CORRESPONDE_AL_DNI: () =>
      "El CUIL no contiene el número de documento del DNI. El CUIL y el DNI " +
      "tienen que ser de la misma persona. Revisá los datos de tu cuenta o " +
      "pedí la revisión de un administrador.",

    LICENCIA_NO_CORRESPONDE_AL_DNI: () =>
      "El número de licencia no corresponde al DNI cargado en tu cuenta. La " +
      "licencia tiene que ser tuya. Si creés que es un error, pedí la " +
      "revisión de un administrador.",

    DOCUMENTO_YA_VERIFICADO: () =>
      "Este documento ya está verificado en otra cuenta. Una misma identidad " +
      "no puede verificar dos cuentas. Si creés que es un error, contactá a " +
      "un administrador.",

    RECHAZADO_POR_ADMIN: () =>
      "Un administrador revisó tu documentación y la rechazó. Podés volver a " +
      "enviar fotos de un documento válido.",
  };

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

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
