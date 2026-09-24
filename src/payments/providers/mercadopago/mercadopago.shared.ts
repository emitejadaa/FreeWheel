import { createHash, createHmac, timingSafeEqual } from "crypto";
import type {
  CardDetails,
  FailureDetails,
  PaymentResult,
  ProcessorNotification,
  ProcessorPaymentStatus,
} from "../payment-provider.interface";

/**
 * LO QUE COMPARTEN EL PROVIDER REAL Y EL DE PRUEBAS.
 *
 * Son funciones puras a propósito: la verificación de la firma, la lectura de
 * un aviso y la conversión de importes son exactamente lo que no puede ser
 * distinto entre las pruebas y la producción. Si el provider de pruebas
 * tuviera su propia versión, las pruebas pasarían contra algo que no es lo
 * que corre.
 */

/** Cuánto dura una reserva de fondos en Argentina antes de caerse sola. */
export const DIAS_DE_RESERVA_DE_FONDOS = 7;

/**
 * El margen que se le descuenta a esa duración para no prometer una
 * garantía al límite: un daño que se reclama la última hora del último día
 * llega tarde igual.
 */
const MARGEN_DE_RESERVA_HORAS = 12;

export class InvalidNotificationSignatureError extends Error {
  constructor(motivo: string) {
    super(`Firma del aviso inválida: ${motivo}`);
    this.name = "InvalidNotificationSignatureError";
  }
}

/**
 * VERIFICA LA FIRMA DE UN AVISO DE MERCADO PAGO.
 *
 * Mercado Pago firma cada aviso con HMAC-SHA256 y la clave secreta de la
 * aplicación. La cabecera `x-signature` trae `ts=<timestamp>,v1=<hash>`, y el
 * hash se calcula sobre este manifiesto, con este formato exacto:
 *
 *     id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 *
 * Tres detalles que, mal hechos, rechazan avisos legítimos:
 *   · `data.id` es el de la URL del aviso (query `data.id`), y si trae letras
 *     se pasa a minúsculas;
 *   · si falta alguno de los valores, su parte se SACA del manifiesto (no se
 *     deja vacía);
 *   · la comparación es de tiempo constante, para no filtrar el hash por
 *     cuánto tarda en decir que no.
 *
 * También se rechaza un aviso con más de `toleranciaSeg` de antigüedad. El
 * margen es amplio (72 horas) a propósito: Mercado Pago reintenta los avisos
 * que no se contestaron, y un reintento legítimo rechazado por viejo es un
 * cobro que se aprueba sin que nadie se entere. Reenviar un aviso viejo no
 * sirve para nada malo: un aviso es solo una pista, y el estado se consulta
 * siempre a la API.
 */
export function verifyMercadoPagoSignature(input: {
  secret: string;
  signatureHeader?: string | null;
  requestId?: string | null;
  dataId?: string | null;
  now?: Date;
  toleranciaSeg?: number;
}): void {
  if (!input.secret) {
    throw new InvalidNotificationSignatureError(
      "no hay clave secreta configurada (MP_WEBHOOK_SECRET)",
    );
  }
  const header = input.signatureHeader?.trim();
  if (!header) {
    throw new InvalidNotificationSignatureError(
      "falta la cabecera x-signature",
    );
  }

  const partes = new Map<string, string>();
  for (const trozo of header.split(",")) {
    const [clave, ...resto] = trozo.split("=");
    if (clave && resto.length > 0) {
      partes.set(clave.trim(), resto.join("=").trim());
    }
  }
  const ts = partes.get("ts");
  const v1 = partes.get("v1");
  if (!ts || !v1) {
    throw new InvalidNotificationSignatureError("la cabecera no trae ts y v1");
  }

  const tolerancia = input.toleranciaSeg ?? 72 * 60 * 60;
  const segundos = Number(ts) > 1e12 ? Number(ts) / 1000 : Number(ts);
  const ahora = (input.now ?? new Date()).getTime() / 1000;
  if (!Number.isFinite(segundos) || Math.abs(ahora - segundos) > tolerancia) {
    throw new InvalidNotificationSignatureError(
      "el aviso es demasiado viejo o viene del futuro",
    );
  }

  const manifiesto = buildSignatureManifest({
    dataId: input.dataId,
    requestId: input.requestId,
    ts,
  });
  const esperado = createHmac("sha256", input.secret)
    .update(manifiesto)
    .digest("hex");

  const a = Buffer.from(esperado, "hex");
  const b = Buffer.from(v1, /^[0-9a-f]+$/i.test(v1) ? "hex" : "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidNotificationSignatureError("el hash no coincide");
  }
}

/** El manifiesto que se firma. Exportado para poder firmar en las pruebas. */
export function buildSignatureManifest(input: {
  dataId?: string | null;
  requestId?: string | null;
  ts: string;
}): string {
  const id = input.dataId
    ? /[a-z]/i.test(input.dataId)
      ? input.dataId.toLowerCase()
      : input.dataId
    : null;
  return (
    (id ? `id:${id};` : "") +
    (input.requestId ? `request-id:${input.requestId};` : "") +
    `ts:${input.ts};`
  );
}

/** Firma un aviso como lo firma Mercado Pago. Solo para las pruebas. */
export function signMercadoPagoNotification(input: {
  secret: string;
  dataId?: string | null;
  requestId?: string | null;
  ts?: string;
}): string {
  const ts = input.ts ?? String(Math.floor(Date.now() / 1000));
  const v1 = createHmac("sha256", input.secret)
    .update(
      buildSignatureManifest({
        dataId: input.dataId,
        requestId: input.requestId,
        ts,
      }),
    )
    .digest("hex");
  return `ts=${ts},v1=${v1}`;
}

/**
 * LEE UN AVISO.
 *
 * Mercado Pago manda el mismo aviso en dos formatos según cómo se configuró:
 * el de webhooks (`{"type":"payment","data":{"id":"123"}, ...}` en el cuerpo,
 * y `?data.id=123&type=payment` en la URL) y el viejo de IPN
 * (`?topic=payment&id=123`, sin cuerpo útil). Se aceptan los dos.
 */
export function parseMercadoPagoNotification(input: {
  body: unknown;
  query: Record<string, unknown>;
}): ProcessorNotification {
  const body =
    input.body && typeof input.body === "object"
      ? (input.body as Record<string, unknown>)
      : {};
  const data =
    body.data && typeof body.data === "object"
      ? (body.data as Record<string, unknown>)
      : {};
  const texto = (valor: unknown): string | null =>
    typeof valor === "string" && valor.trim()
      ? valor.trim()
      : typeof valor === "number" && Number.isFinite(valor)
        ? String(valor)
        : null;

  const topic =
    texto(input.query.type) ??
    texto(input.query.topic) ??
    texto(body.type) ??
    texto(body.topic) ??
    "unknown";
  const dataId =
    texto(input.query["data.id"]) ??
    texto(data.id) ??
    texto(input.query.id) ??
    texto(body.resource) ??
    null;

  return {
    topic,
    action: texto(body.action),
    dataId,
    notificationId: texto(body.id),
    collectorUserId: texto(body.user_id),
    liveMode: typeof body.live_mode === "boolean" ? body.live_mode : null,
  };
}

/** Pesos con centavos (lo que pide Mercado Pago) desde unidades mínimas. */
export function aPesos(minor: number): number {
  return Math.round(minor) / 100;
}

/** Unidades mínimas desde un importe de Mercado Pago. */
export function aMinor(importe: unknown): number {
  const n = typeof importe === "string" ? Number(importe) : Number(importe);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const ESTADOS: ProcessorPaymentStatus[] = [
  "approved",
  "authorized",
  "in_process",
  "pending",
  "rejected",
  "cancelled",
  "refunded",
  "charged_back",
  "in_mediation",
];

export function normalizarEstado(status: unknown): ProcessorPaymentStatus {
  const s = typeof status === "string" ? status.toLowerCase() : "";
  return (ESTADOS as string[]).includes(s)
    ? (s as ProcessorPaymentStatus)
    : "pending";
}

/**
 * LOS MOTIVOS DE RECHAZO, EN CASTELLANO.
 *
 * Mercado Pago contesta con un código (`cc_rejected_insufficient_amount`) y
 * el front necesita las dos cosas: el código para decidir qué pantalla
 * mostrar y una frase que se le pueda leer a una persona.
 */
const MENSAJES: Record<string, string> = {
  cc_rejected_insufficient_amount: "La tarjeta no tiene fondos suficientes.",
  cc_rejected_bad_filled_security_code:
    "El código de seguridad no es correcto.",
  cc_rejected_bad_filled_date: "La fecha de vencimiento no es correcta.",
  cc_rejected_bad_filled_card_number: "El número de tarjeta no es correcto.",
  cc_rejected_bad_filled_other: "Revisá los datos de la tarjeta.",
  cc_rejected_call_for_authorize:
    "Tu banco necesita que autorices este pago. Llamalo y volvé a intentar.",
  cc_rejected_card_disabled:
    "La tarjeta está inhabilitada. Activala con tu banco o usá otra.",
  cc_rejected_duplicated_payment:
    "Ya hiciste un pago igual hace un momento. Si necesitás pagar de nuevo, usá otra tarjeta.",
  cc_rejected_high_risk:
    "El pago fue rechazado por seguridad. Probá con otra tarjeta o medio de pago.",
  cc_rejected_max_attempts:
    "Llegaste al límite de intentos con esta tarjeta. Probá con otra.",
  cc_rejected_invalid_installments:
    "La tarjeta no acepta esa cantidad de cuotas.",
  cc_rejected_blacklist: "No se pudo procesar el pago con esta tarjeta.",
  cc_rejected_card_type_not_allowed: "Este tipo de tarjeta no está permitido.",
  cc_rejected_other_reason:
    "La tarjeta rechazó el pago. Probá con otra tarjeta.",
  pending_contingency:
    "El pago se está procesando. Te avisamos cuando se acredite.",
  pending_review_manual:
    "El pago está en revisión. Te avisamos cuando se resuelva.",
  pending_challenge: "Tu banco pide que confirmes el pago.",
};

export function mensajeDelMotivo(statusDetail: string | null): string | null {
  if (!statusDetail) return null;
  return MENSAJES[statusDetail] ?? "La tarjeta rechazó el pago.";
}

/**
 * UN IDENTIFICADOR ESTABLE DE LA TARJETA, sin guardar la tarjeta.
 *
 * Mercado Pago no da un fingerprint que sirva entre cuentas. Se arma uno con
 * lo que sí devuelve y no es secreto: los primeros seis dígitos (el banco),
 * los últimos cuatro, el vencimiento y el documento del titular. Hasheado,
 * porque junto sirve para reconocer la tarjeta y no hace falta que se pueda
 * leer.
 */
export function huellaDeTarjeta(card: {
  firstSix?: string | null;
  lastFour?: string | null;
  expMonth?: number | string | null;
  expYear?: number | string | null;
  holderDocument?: string | null;
}): string | null {
  if (!card.lastFour) return null;
  const base = [
    card.firstSix ?? "",
    card.lastFour,
    card.expMonth ?? "",
    card.expYear ?? "",
    card.holderDocument ?? "",
  ].join("|");
  return `mpfp_${createHash("sha256").update(base).digest("hex").slice(0, 32)}`;
}

/**
 * Hasta cuándo sirve una reserva de fondos, desde que se autorizó.
 *
 * Mercado Pago no devuelve ese dato en el pago: la regla para Argentina es
 * que la reserva vale 7 días. Se descuenta un margen para no prometerle al
 * dueño una garantía que se cae en el medio de un reclamo.
 */
export function vencimientoDeReserva(desde: Date): Date {
  return new Date(
    desde.getTime() +
      (DIAS_DE_RESERVA_DE_FONDOS * 24 - MARGEN_DE_RESERVA_HORAS) * 3_600_000,
  );
}

/** Lee la respuesta de la API de pagos de Mercado Pago. */
export function leerPago(json: Record<string, unknown>): PaymentResult {
  const card =
    json.card && typeof json.card === "object"
      ? (json.card as Record<string, unknown>)
      : null;
  const holder =
    card?.cardholder && typeof card.cardholder === "object"
      ? (card.cardholder as Record<string, unknown>)
      : null;
  const holderId =
    holder?.identification && typeof holder.identification === "object"
      ? (holder.identification as Record<string, unknown>)
      : null;
  const status = normalizarEstado(json.status);
  const statusDetail =
    typeof json.status_detail === "string" ? json.status_detail : null;

  const tarjeta: CardDetails | null = card
    ? {
        brand:
          typeof json.payment_method_id === "string"
            ? json.payment_method_id
            : null,
        last4:
          typeof card.last_four_digits === "string"
            ? card.last_four_digits
            : null,
        fingerprint: huellaDeTarjeta({
          firstSix:
            typeof card.first_six_digits === "string"
              ? card.first_six_digits
              : null,
          lastFour:
            typeof card.last_four_digits === "string"
              ? card.last_four_digits
              : null,
          expMonth: card.expiration_month as number | null,
          expYear: card.expiration_year as number | null,
          holderDocument:
            typeof holderId?.number === "string" ? holderId.number : null,
        }),
        country: null,
      }
    : null;

  const failure: FailureDetails | null =
    status === "rejected"
      ? { code: statusDetail, message: mensajeDelMotivo(statusDetail) }
      : null;

  const fecha = (valor: unknown): Date | null => {
    if (typeof valor !== "string") return null;
    const d = new Date(valor);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const aprobado = fecha(json.date_approved);
  const creado = fecha(json.date_created);

  const detalles =
    json.transaction_details && typeof json.transaction_details === "object"
      ? (json.transaction_details as Record<string, unknown>)
      : {};

  return {
    id: String(json.id),
    status,
    statusDetail,
    amountMinor: aMinor(json.transaction_amount),
    capturedMinor:
      status === "approved" || status === "refunded"
        ? aMinor(detalles.total_paid_amount ?? json.transaction_amount)
        : null,
    refundedMinor: aMinor(json.transaction_amount_refunded ?? 0),
    currency: typeof json.currency_id === "string" ? json.currency_id : "ARS",
    externalReference:
      typeof json.external_reference === "string"
        ? json.external_reference
        : null,
    kind:
      json.metadata &&
      typeof json.metadata === "object" &&
      typeof (json.metadata as Record<string, unknown>).kind === "string"
        ? String((json.metadata as Record<string, unknown>).kind).toUpperCase()
        : null,
    collectorId: idDeCobrador(json),
    liveMode: json.live_mode === true,
    card: tarjeta,
    risk: null,
    failure,
    captureBefore:
      status === "authorized"
        ? vencimientoDeReserva(aprobado ?? creado ?? new Date())
        : null,
    approvedAt: aprobado,
  };
}

/** El cobrador de un pago: `collector_id` o `collector.id`, como texto. */
function idDeCobrador(json: Record<string, unknown>): string | null {
  const plano = json.collector_id;
  if (typeof plano === "string" || typeof plano === "number")
    return String(plano);
  const anidado =
    json.collector && typeof json.collector === "object"
      ? (json.collector as Record<string, unknown>).id
      : null;
  return typeof anidado === "string" || typeof anidado === "number"
    ? String(anidado)
    : null;
}
