import { VehicleVerification, VehicleVerificationStatus } from "@prisma/client";

/**
 * LAS REGLAS DE LA VERIFICACIÓN DE UN AUTO, COMO FUNCIONES PURAS.
 *
 * Viven fuera del servicio por el mismo motivo que driving-eligibility.ts: son
 * las que deciden si un auto se puede publicar, y una regla que decide algo así
 * tiene que poder probarse caso por caso sin levantar una base ni un Cloudinary
 * de mentira. El servicio las llama; no las reimplementa.
 */

// ── Patente ─────────────────────────────────────────────────────────────────

/**
 * "ab 123-cd" → "AB123CD".
 *
 * Se guarda y se compara SIEMPRE normalizada. La misma patente escrita con
 * guion, con espacios o en minúscula es la misma patente, y si se guardara tal
 * cual la escribió cada uno, el control de patente duplicada —que es el que
 * atrapa a los autos mellizos— se esquivaría con un espacio.
 */
export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[\s.-]/g, "");
}

/**
 * Los dos formatos de patente de auto vigentes en Argentina:
 *
 *   · ANTIGUA  — ABC123   (1995 a 2016)
 *   · MERCOSUR — AB123CD  (desde 2016)
 *
 * Quedan afuera a propósito las patentes de moto del Mercosur (A123BCD), que no
 * son autos, y las provinciales anteriores a 1995, que ya no circulan con esa
 * chapa: un auto de esa época tuvo que re-patentarse con el formato de 1995.
 */
export type PlateFormat = "ANTIGUA" | "MERCOSUR";

export function plateFormat(normalized: string): PlateFormat | null {
  if (/^[A-Z]{3}\d{3}$/.test(normalized)) return "ANTIGUA";
  if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(normalized)) return "MERCOSUR";
  return null;
}

// ── Número de chasis (VIN) ──────────────────────────────────────────────────

export function normalizeVin(raw: string): string {
  return raw.toUpperCase().replace(/[\s.-]/g, "");
}

export type VinProblem = "LONGITUD" | "LETRA_PROHIBIDA" | "CARACTER_INVALIDO";

/**
 * Qué tiene de malo un número de chasis, o null si sirve.
 *
 * Es un VIN de 17 caracteres, que es lo que llevan los autos fabricados o
 * importados en Argentina desde los noventa. Sin las letras I, O y Q: el
 * estándar las excluye porque se confunden con 1 y 0, y es justamente el error
 * de carga más común —leer una O donde hay un cero—, así que se nombra aparte
 * para que el mensaje pueda decirlo.
 *
 * NO se valida el dígito verificador (la posición 9). Es obligatorio en
 * Norteamérica, pero los fabricantes europeos y del Mercosur no están obligados
 * a calcularlo: exigirlo rechazaría chasis reales de autos armados acá.
 */
export function vinProblem(normalized: string): VinProblem | null {
  if (normalized.length !== 17) return "LONGITUD";
  if (/[IOQ]/.test(normalized)) return "LETRA_PROHIBIDA";
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(normalized)) return "CARACTER_INVALIDO";
  return null;
}

// ── Titular ─────────────────────────────────────────────────────────────────

/** "20.123.456" → "20123456". */
export function normalizeDni(raw: string): string {
  return raw.replace(/[\s.-]/g, "");
}

export function isValidDni(normalized: string): boolean {
  return /^\d{7,8}$/.test(normalized);
}

/**
 * Dos DNI son el mismo aunque uno venga con un cero adelante: "01234567" y
 * "1234567" son el mismo documento escrito con distinto relleno.
 */
export function sameDni(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const limpio = (valor: string) => normalizeDni(valor).replace(/^0+/, "");
  return limpio(a) !== "" && limpio(a) === limpio(b);
}

/**
 * "Pérez, Juan Carlos" → "PEREZ JUAN CARLOS".
 *
 * Sin tildes, sin puntuación y en mayúscula, que es como imprime los nombres la
 * cédula. Los guiones y apóstrofos pasan a ser espacios en los DOS lados de la
 * comparación, así "Pérez-García" y "PEREZ GARCIA" son el mismo apellido, y
 * "D'Alessandro" coincide con "D ALESSANDRO".
 */
export function normalizePersonName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¿El nombre de la cédula es el de esta persona?
 *
 * Acepta los dos órdenes en que se escribe un nombre acá: "JUAN PEREZ" y
 * "PEREZ JUAN". El segundo es el de la cédula y el de casi cualquier trámite,
 * así que exigir el orden del perfil haría fallar al titular real por copiar
 * su nombre tal como lo tiene impreso.
 *
 * Solo esos dos órdenes, y no cualquier permutación de palabras: con palabras
 * sueltas en cualquier orden, "JUAN CARLOS PEREZ" coincidiría con
 * "CARLOS PEREZ JUAN", que ya es otra forma de decir un nombre distinto.
 */
export function holderNameMatches(
  declared: string,
  firstName: string,
  lastName: string,
): boolean {
  const nombre = normalizePersonName(declared);
  if (!nombre) return false;
  const first = normalizePersonName(firstName);
  const last = normalizePersonName(lastName);
  return nombre === `${first} ${last}` || nombre === `${last} ${first}`;
}

// ── Fechas ──────────────────────────────────────────────────────────────────

/**
 * "2027-03-15" → Date a MEDIODÍA UTC, o null si no es una fecha real.
 *
 * Mediodía y no medianoche por lo mismo que en la verificación de identidad:
 * una fecha guardada a las 00:00 UTC, leída en Argentina, cae el día anterior.
 * El round-trip descarta fechas que no existen (2027-02-31 se convertiría en
 * marzo sin avisar).
 */
export function parseDay(iso: string | null | undefined): Date | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const fecha = new Date(`${iso}T12:00:00.000Z`);
  if (Number.isNaN(fecha.getTime())) return null;
  return fecha.toISOString().slice(0, 10) === iso ? fecha : null;
}

export function isoDay(fecha: Date | null): string | null {
  return fecha ? fecha.toISOString().slice(0, 10) : null;
}

/** Medianoche UTC del día de una fecha: todo se compara por DÍA. */
export function startOfDayUtc(fecha: Date): Date {
  return new Date(
    Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()),
  );
}

/**
 * ¿Ya venció? Un seguro que vence el 7 cubre todo el 7: vencido es ANTES de
 * hoy, no hoy. Es el mismo criterio que las licencias (driving-eligibility.ts).
 */
export function isExpired(fecha: Date, now: Date = new Date()): boolean {
  return startOfDayUtc(fecha) < startOfDayUtc(now);
}

/** Cuántos días antes del vencimiento del seguro se empieza a avisar. */
export const DIAS_DE_AVISO_SEGURO = 30;

function daysUntil(fecha: Date, now: Date): number {
  const MS_POR_DIA = 24 * 60 * 60 * 1000;
  return Math.round(
    (startOfDayUtc(fecha).getTime() - startOfDayUtc(now).getTime()) /
      MS_POR_DIA,
  );
}

// ── Enmascarado ─────────────────────────────────────────────────────────────

/**
 * "8AJFB8CD3N1234567" → "****4567".
 *
 * Al dueño se le muestra lo que declaró solo para que lo reconozca, no para que
 * lo lea: con los últimos cuatro alcanza para saber si cargó el número bien, y
 * quien le robe la sesión no se lleva el chasis, el DNI del titular ni la
 * póliza. Los asteriscos son siempre cuatro, así el enmascarado no dice cuánto
 * mide el dato. Un valor de cuatro caracteres o menos se tapa entero: mostrar
 * "los últimos cuatro" sería mostrarlo todo.
 */
export function maskTail(value: string | null): string | null {
  if (value === null) return null;
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

// ── ¿El auto está habilitado? ───────────────────────────────────────────────

/**
 * Por qué un auto no está habilitado, con código estable y mensaje listo para
 * mostrar. Los códigos van en castellano como los motivos de la verificación de
 * identidad; los códigos HTTP (VEHICLE_NOT_VERIFIED…) son otra cosa: dicen qué
 * falló, estos dicen por qué.
 */
export type VehicleReasonCode =
  | "VERIFICACION_NO_ENVIADA"
  | "VERIFICACION_EN_REVISION"
  | "RECHAZADO_POR_ADMIN"
  | "PATENTE_CAMBIADA"
  | "OTRO_DUENO"
  | "SEGURO_VENCIDO"
  | "SEGURO_SIN_FECHA";

export interface VehicleReason {
  code: VehicleReasonCode;
  message: string;
}

const MENSAJES: Record<VehicleReasonCode, string> = {
  VERIFICACION_NO_ENVIADA:
    "Todavía no enviaste la cédula del auto para verificar que es tuyo.",
  VERIFICACION_EN_REVISION:
    "La documentación del auto está en revisión. Te avisamos cuando esté lista.",
  RECHAZADO_POR_ADMIN:
    "La documentación del auto fue rechazada. Volvé a enviar la cédula y los datos del seguro.",
  PATENTE_CAMBIADA:
    "La patente del auto cambió desde que se verificó. Volvé a enviar la cédula con la patente nueva.",
  OTRO_DUENO:
    "La verificación de este auto la hizo otra cuenta. Enviá la cédula desde la cuenta del dueño actual.",
  SEGURO_VENCIDO:
    "El seguro del auto está vencido. Enviá la póliza renovada para volver a publicarlo.",
  SEGURO_SIN_FECHA:
    "No tenemos la fecha de vencimiento del seguro del auto. Volvé a enviar los datos de la póliza.",
};

export function vehicleReason(code: VehicleReasonCode): VehicleReason {
  return { code, message: MENSAJES[code] };
}

/** Lo que hace falta de la verificación para evaluarla. */
export type StandingRow = Pick<
  VehicleVerification,
  "status" | "ownerId" | "plate" | "insuranceExpiresAt" | "vtvExpiresAt"
>;

export interface VehicleStanding {
  /** Si el auto se puede publicar y recibir reservas ahora mismo. */
  verified: boolean;
  /**
   * Qué lo impide. Si la verificación en sí está bien y lo único que falla es
   * el seguro, `insuranceOnly` es true: es lo que distingue un 409
   * VEHICLE_INSURANCE_EXPIRED (renová la póliza) de un VEHICLE_NOT_VERIFIED
   * (verificá el auto).
   */
  reasons: VehicleReason[];
  insuranceOnly: boolean;
  insuranceValid: boolean;
  /** Vigente pero vence dentro de DIAS_DE_AVISO_SEGURO: para avisar antes. */
  insuranceExpiresSoon: boolean;
  /**
   * La VTV no bloquea nada: no la tienen que tener los autos nuevos y cada
   * jurisdicción la exige distinto, así que es un dato para quien revisa y un
   * aviso para el dueño. null cuando no se declaró.
   */
  vtvValid: boolean | null;
  /** false si la patente del auto ya no es la que se verificó. */
  plateMatchesVehicle: boolean;
}

/**
 * ¿ESTE AUTO ESTÁ HABILITADO HOY?
 *
 * Se evalúa en el momento de usarlo y no con un proceso programado, por lo
 * mismo que las licencias: un job nocturno deja una ventana de hasta un día
 * entre que el seguro vence y alguien se entera, y en esa ventana se puede
 * alquilar un auto sin cobertura.
 *
 * Una verificación aprobada deja de valer sola en dos casos que no pasan por
 * ningún admin:
 *
 *   · la patente del auto cambió. Verificar un auto legítimo y después
 *     cambiarle la patente por la de otro es exactamente cómo se publicaría un
 *     mellizo con una verificación prestada;
 *   · el auto cambió de dueño. La cédula que vio el admin respaldaba a quien la
 *     envió, no a quien lo tenga ahora.
 *
 * A diferencia de la licencia, un seguro SIN fecha SÍ bloquea. Allá la regla
 * es "lo que no se sabe no bloquea" porque había cuentas aprobadas antes de que
 * el dato existiera; acá no hay filas viejas —el envío exige la fecha desde el
 * primer día— así que una aprobada sin fecha solo puede ser un error, y un auto
 * del que no sabemos si tiene seguro no se alquila.
 */
export function evaluateVehicleStanding(
  row: StandingRow | null,
  vehicle: { ownerId: string; plate: string | null },
  now: Date = new Date(),
): VehicleStanding {
  const plateMatchesVehicle =
    !row || !vehicle.plate || normalizePlate(vehicle.plate) === row.plate;

  const seguro = row?.insuranceExpiresAt ?? null;
  const insuranceValid = Boolean(seguro && !isExpired(seguro, now));
  const insuranceExpiresSoon = Boolean(
    seguro && insuranceValid && daysUntil(seguro, now) <= DIAS_DE_AVISO_SEGURO,
  );
  const vtv = row?.vtvExpiresAt ?? null;
  const vtvValid = vtv ? !isExpired(vtv, now) : null;

  const base = {
    insuranceValid,
    insuranceExpiresSoon,
    vtvValid,
    plateMatchesVehicle,
  };

  const verification: VehicleReason[] = [];
  if (!row) {
    verification.push(vehicleReason("VERIFICACION_NO_ENVIADA"));
  } else if (row.status === VehicleVerificationStatus.PENDING) {
    verification.push(vehicleReason("VERIFICACION_EN_REVISION"));
  } else if (row.status === VehicleVerificationStatus.REJECTED) {
    verification.push(vehicleReason("RECHAZADO_POR_ADMIN"));
  } else {
    if (row.ownerId !== vehicle.ownerId) {
      verification.push(vehicleReason("OTRO_DUENO"));
    }
    if (!plateMatchesVehicle) {
      verification.push(vehicleReason("PATENTE_CAMBIADA"));
    }
  }

  const insurance: VehicleReason[] = [];
  if (row && !seguro) insurance.push(vehicleReason("SEGURO_SIN_FECHA"));
  else if (seguro && !insuranceValid) {
    insurance.push(vehicleReason("SEGURO_VENCIDO"));
  }

  // El seguro solo se reporta cuando la verificación en sí está bien. Sobre
  // una en revisión o rechazada, "tu seguro venció" sería un segundo problema
  // que no es el que hay que resolver primero: el envío nuevo ya trae la
  // póliza.
  const reasons = verification.length > 0 ? verification : insurance;

  return {
    ...base,
    verified: reasons.length === 0,
    reasons,
    insuranceOnly: verification.length === 0 && insurance.length > 0,
  };
}
