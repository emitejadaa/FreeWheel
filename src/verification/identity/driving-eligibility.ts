import {
  VerificationReason,
  verificationReason,
} from "../errors/verification-reasons";
import { habilitaAuto } from "./identity-match.service";

/**
 * ¿ESTA PERSONA PUEDE ALQUILAR UN AUTO AHORA MISMO?
 *
 * Una cuenta verificada no es lo mismo que una persona habilitada a manejar.
 * La verificación dice "sos quien decís ser" y se resuelve una vez; esto dice
 * "hoy podés conducir" y puede cambiar sin que nadie toque nada, simplemente
 * porque pasó el tiempo y la licencia venció.
 *
 * ── De dónde salen estos datos ───────────────────────────────────────────────
 * Los declaró la persona al enviar su licencia, leyéndolos de la licencia, y
 * la lectura automática los corroboró contra la foto antes de aprobarla. No
 * salen de un OCR: un vencimiento mal leído dejaba una cuenta verificada y sin
 * poder reservar, y la persona no tenía cómo corregir un dato que no había
 * cargado ella.
 *
 * ── Se evalúa en cada pedido, no con un proceso programado ───────────────────
 * La tentación es un job nocturno que marque las licencias vencidas. El
 * problema es la ventana: entre que una licencia vence y el job se entera pasan
 * hasta 24 horas, y en esas horas alguien puede alquilar un auto sin
 * habilitación — que es exactamente lo que este control existe para impedir.
 * Comparar contra la fecha de hoy en el momento de decidir no tiene ventana, y
 * encima es menos código y una cosa menos que puede fallar en silencio.
 *
 * ── Lo que no se sabe no bloquea ─────────────────────────────────────────────
 * Un vencimiento en `null` NO impide alquilar. Es importante y es deliberado:
 * hay licencias aprobadas por un admin sin que nadie cargara la fecha, y en
 * esas filas el dato nunca existió. Tratar "no sé cuándo vence" como "está
 * vencida" dejaría afuera, el día del deploy, a cuentas ya verificadas — un
 * cambio que no arregla ningún fraude y rompe a usuarios reales. El dato se
 * completa solo a medida que se verifican o reverifican documentos.
 *
 * Mismo criterio para la clase: si no está cargada, no se asume que es de moto.
 */

/** Lo que hace falta saber de alguien para decidir si puede manejar. */
export interface DrivingCredentials {
  licenseExpiresAt: Date | null;
  licenseClass: string | null;
  licenseBeginnerUntil: Date | null;
}

export interface DrivingEligibility {
  /** Si puede alquilar un auto ahora. */
  canRent: boolean;
  /**
   * Por qué no puede, con código y mensaje listo para mostrar. Vacío cuando
   * puede.
   */
  reasons: VerificationReason[];
  licenseExpiresAt: Date | null;
  /**
   * Si la licencia vence dentro de los próximos 30 días. Todavía puede
   * alquilar; es para avisarle antes de que se quede afuera de golpe.
   */
  expiresSoon: boolean;
}

/** Cuántos días antes del vencimiento se empieza a avisar. */
const DIAS_DE_AVISO = 30;

export function evaluateDrivingEligibility(
  credentials: DrivingCredentials,
  now: Date = new Date(),
): DrivingEligibility {
  const hoy = comienzoDelDia(now);
  const reasons: VerificationReason[] = [];

  const vence = credentials.licenseExpiresAt;
  if (vence && comienzoDelDia(vence) < hoy) {
    reasons.push(
      verificationReason("LICENCIA_VENCIDA", { date: isoCorto(vence) }),
    );
  }

  // `habilitaAuto` es la misma función que usa el cruce al aprobar el
  // documento. Comparten implementación a propósito: dos listas de clases
  // habilitantes en dos archivos terminan divergiendo, y el resultado sería
  // aprobar una licencia que después no habilita nada, sin que nadie entienda
  // por qué.
  if (credentials.licenseClass && !habilitaAuto(credentials.licenseClass)) {
    reasons.push(
      verificationReason("LICENCIA_CLASE_NO_HABILITA", {
        detail: credentials.licenseClass,
      }),
    );
  }

  const principiante = credentials.licenseBeginnerUntil;
  if (principiante && comienzoDelDia(principiante) >= hoy) {
    reasons.push(
      verificationReason("LICENCIA_PRINCIPIANTE", {
        date: isoCorto(principiante),
      }),
    );
  }

  return {
    canRent: reasons.length === 0,
    reasons,
    licenseExpiresAt: vence,
    expiresSoon:
      Boolean(vence) &&
      reasons.length === 0 &&
      diasHasta(vence as Date, hoy) <= DIAS_DE_AVISO,
  };
}

/**
 * ¿LA IDENTIDAD DE ESTA PERSONA SIGUE RESPALDADA HOY?
 *
 * Es el control paralelo al de manejar, pero sobre el DNI, y gobierna TODO lo
 * sensible: reservar, publicar, pagar, cobrar.
 *
 * Existe porque verificar una identidad no es para siempre. Un DNI vencido no
 * deja de decir quién es la persona —por eso la cuenta sigue VERIFIED y no
 * vuelve a cero— pero deja de ser un documento con el que la plataforma pueda
 * respaldar una operación con plata adentro. La salida es renovar el documento
 * y volver a enviarlo, no verificarse de nuevo desde el principio.
 *
 * Mismo criterio que arriba: un vencimiento desconocido no bloquea. Bloquear a
 * todas las cuentas verificadas antes de que existiera este dato no atrapa
 * ningún fraude y rompe a todos los usuarios reales.
 */
export interface IdentityCredentials {
  dniExpiresAt: Date | null;
}

export interface IdentityValidity {
  /** Si su identidad tiene respaldo documental vigente. */
  valid: boolean;
  reasons: VerificationReason[];
  dniExpiresAt: Date | null;
  expiresSoon: boolean;
}

export function evaluateIdentityValidity(
  credentials: IdentityCredentials,
  now: Date = new Date(),
): IdentityValidity {
  const hoy = comienzoDelDia(now);
  const vence = credentials.dniExpiresAt;
  const vencido = Boolean(vence && comienzoDelDia(vence) < hoy);

  return {
    valid: !vencido,
    reasons: vencido
      ? [
          verificationReason("DNI_VENCIDO", {
            date: isoCorto(vence as Date),
          }),
        ]
      : [],
    dniExpiresAt: vence,
    expiresSoon:
      Boolean(vence) &&
      !vencido &&
      diasHasta(vence as Date, hoy) <= DIAS_DE_AVISO,
  };
}

/**
 * Medianoche UTC del día de una fecha.
 *
 * Todo se compara a nivel de DÍA y no de instante: una licencia que vence el 7
 * habilita durante todo el 7. Comparar instantes haría que dejara de valer a
 * la hora exacta en que se guardó la fecha, que es un detalle de cómo se
 * escribió el dato y no algo que nadie quiso decir.
 */
function comienzoDelDia(fecha: Date): Date {
  return new Date(
    Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()),
  );
}

function isoCorto(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

function diasHasta(fecha: Date, desde: Date): number {
  const MS_POR_DIA = 24 * 60 * 60 * 1000;
  return Math.ceil(
    (comienzoDelDia(fecha).getTime() - desde.getTime()) / MS_POR_DIA,
  );
}
