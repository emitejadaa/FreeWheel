/**
 * LA FRONTERA CON EL PROCESADOR DE PAGOS.
 *
 * El procesador de verdad es Mercado Pago, con el modelo de marketplace que
 * Mercado Pago llama "split de pagos 1:1":
 *
 *   · cada dueño vincula SU cuenta de Mercado Pago con FreeWheel (OAuth);
 *   · el cobro de una reserva se crea con el token del DUEÑO, así que la plata
 *     entra directo a su cuenta;
 *   · FreeWheel se queda con su parte como `application_fee`, que Mercado Pago
 *     acredita en la cuenta de FreeWheel en el mismo cobro.
 *
 * Es el modelo que se eligió a propósito: FreeWheel nunca custodia plata de
 * los dueños. Cobrar todo en una cuenta propia y transferirle al dueño después
 * es, funcionalmente, custodiar fondos de terceros, que es justo lo que regula
 * el régimen de PSP del BCRA (ver CONSULTAS-LEGALES.md §3).
 *
 * Todos los importes son enteros en unidades mínimas (centavos). La
 * conversión a pesos con decimales, que es lo que pide la API de Mercado Pago,
 * se hace adentro del provider y en ningún otro lado.
 *
 * ── Quién decide si un pago pasa ────────────────────────────────────────────
 * El procesador, siempre. Este backend nunca recibe un número de tarjeta: el
 * front lo tokeniza con el SDK de Mercado Pago y acá llega el token. Lo que
 * este backend hace con la respuesta es registrarla entera, que es lo que
 * después permite responder un desconocimiento de cobro.
 */

export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");

export type PaymentRecordKindLike =
  | "CHECKOUT"
  | "SENA"
  | "BALANCE"
  | "DEPOSIT_HOLD";

/**
 * LA CUENTA QUE COBRA: la del dueño del auto.
 *
 * El access token viaja descifrado solo en memoria y solo hasta el provider.
 * No se loguea, no se devuelve y no se guarda así en ningún lado.
 */
export interface CollectorCredentials {
  /** El user_id de Mercado Pago del dueño. */
  userId: string;
  accessToken: string;
}

/**
 * La tarjeta, tal como la deja el SDK de Mercado Pago del front: un token de
 * un solo uso más lo que la persona eligió (cuotas, emisor). Nunca el número.
 */
export interface CardPaymentInput {
  token: string;
  paymentMethodId: string;
  issuerId?: string | null;
  installments: number;
  payer: {
    email: string;
    identification?: { type: string; number: string } | null;
    firstName?: string | null;
    lastName?: string | null;
  };
  /**
   * El identificador del dispositivo que arma el SDK de Mercado Pago
   * (MP_DEVICE_SESSION_ID). Mejora la aprobación: sin él, el antifraude de
   * Mercado Pago rechaza más pagos legítimos.
   */
  deviceSessionId?: string | null;
}

export interface PaymentItem {
  id: string;
  title: string;
  description?: string;
  quantity: number;
  unitPriceMinor: number;
  categoryId?: string;
}

export interface CreatePaymentInput {
  bookingId: string;
  kind: PaymentRecordKindLike;
  amountMinor: number;
  currency: string;
  /**
   * Lo que se queda FreeWheel: comisión + cobertura en el cobro de la
   * reserva, cero en el depósito (lo que se cobre de un depósito es del
   * dueño, como indemnización).
   */
  applicationFeeMinor: number;
  /** false = reserva de fondos: se autoriza y se captura después. */
  capture: boolean;
  card: CardPaymentInput;
  collector: CollectorCredentials;
  description: string;
  externalReference: string;
  notificationUrl?: string | null;
  statementDescriptor?: string | null;
  metadata?: Record<string, string>;
  items?: PaymentItem[];
  /**
   * Clave de idempotencia. Un reintento con la MISMA clave devuelve el mismo
   * pago en vez de cobrar otra vez.
   */
  idempotencyKey: string;
}

/**
 * Los estados de un pago, como los nombra Mercado Pago.
 *
 *   · approved     → cobrado.
 *   · authorized   → reserva de fondos vigente, sin capturar (el depósito).
 *   · in_process   → en revisión (antifraude manual, emisor lento).
 *   · pending      → esperando algo de la persona (3-D Secure, un medio offline).
 *   · rejected     → rechazado; `statusDetail` dice por qué.
 *   · cancelled    → cancelado (una reserva de fondos soltada o vencida).
 *   · refunded     → devuelto entero.
 *   · charged_back → la persona desconoció el cobro ante su banco.
 *   · in_mediation → hay un reclamo abierto en Mercado Pago.
 */
export type ProcessorPaymentStatus =
  | "approved"
  | "authorized"
  | "in_process"
  | "pending"
  | "rejected"
  | "cancelled"
  | "refunded"
  | "charged_back"
  | "in_mediation";

/** Las señas de la tarjeta que pagó. Nunca el número. */
export interface CardDetails {
  brand: string | null;
  last4: string | null;
  /**
   * Un identificador estable de la tarjeta. Mercado Pago no da uno entre
   * cuentas, así que se deriva de datos que no son secretos (los primeros
   * seis, los últimos cuatro, el vencimiento y el documento del titular),
   * hasheados. Sirve para lo mismo que el fingerprint de Stripe: ver cinco
   * cuentas nuevas pagando todas con el mismo plástico.
   */
  fingerprint: string | null;
  country: string | null;
}

/** Lo que el procesador opina del riesgo. Mercado Pago no da un puntaje. */
export interface RiskDetails {
  level: string | null;
  score: number | null;
}

/** Por qué no se pudo cobrar, tal como lo dijo el procesador. */
export interface FailureDetails {
  /** El status_detail de Mercado Pago: "cc_rejected_insufficient_amount"... */
  code: string | null;
  message: string | null;
}

/** Lo que se sabe de un pago, en un solo lugar. */
export interface PaymentResult {
  id: string;
  status: ProcessorPaymentStatus;
  statusDetail: string | null;
  amountMinor: number;
  /** Lo que efectivamente se cobró (una captura parcial cobra menos). */
  capturedMinor: number | null;
  /** Lo devuelto hasta ahora. */
  refundedMinor: number;
  currency: string;
  externalReference: string | null;
  /**
   * El tramo (CHECKOUT, DEPOSIT_HOLD…), tal como se mandó en la metadata del
   * pago. Hace falta para reconocer un cobro que se hizo pero cuya respuesta
   * nunca llegó (un corte de red en el peor momento).
   */
  kind: string | null;
  /** La cuenta que cobró. */
  collectorId: string | null;
  liveMode: boolean;
  card: CardDetails | null;
  risk: RiskDetails | null;
  failure: FailureDetails | null;
  /**
   * Hasta cuándo se puede capturar una reserva de fondos. Pasado ese momento
   * Mercado Pago la cancela sola y no hay de dónde cobrar un daño.
   */
  captureBefore: Date | null;
  approvedAt: Date | null;
}

export interface RefundResult {
  id: string;
  amountMinor: number;
  status: string;
}

export interface ChargebackResult {
  id: string;
  paymentIds: string[];
  amountMinor: number;
  reason: string | null;
  status: string | null;
}

/** Lo que devuelve el OAuth de Mercado Pago al vincular una cuenta. */
export interface OAuthCredentials {
  userId: string;
  accessToken: string;
  refreshToken: string;
  publicKey: string;
  expiresAt: Date;
  liveMode: boolean;
}

/**
 * Un aviso del procesador, ya leído. Es SOLO UNA PISTA: dice qué recurso
 * cambió, no cómo quedó. El estado verdadero se consulta siempre a la API
 * con el token del dueño, así que un aviso falso no puede inventar un cobro.
 */
export interface ProcessorNotification {
  /** "payment", "chargebacks", "mp-connect"... */
  topic: string;
  action: string | null;
  dataId: string | null;
  notificationId: string | null;
  /** La cuenta a la que se refiere el aviso (el dueño). */
  collectorUserId: string | null;
  liveMode: boolean | null;
}

export interface PaymentProvider {
  readonly name: string;

  /** true si las credenciales de la plataforma son de producción. */
  readonly liveMode: boolean;

  /** Crea un cobro (o una reserva de fondos, con `capture: false`). */
  createPayment(input: CreatePaymentInput): Promise<PaymentResult>;

  getPayment(
    collector: CollectorCredentials,
    paymentId: string,
  ): Promise<PaymentResult>;

  /** Captura toda o parte de una reserva de fondos. */
  capturePayment(
    collector: CollectorCredentials,
    paymentId: string,
    amountMinor: number,
    idempotencyKey: string,
  ): Promise<PaymentResult>;

  /** Suelta una reserva de fondos (o cancela un pago pendiente). */
  cancelPayment(
    collector: CollectorCredentials,
    paymentId: string,
    idempotencyKey: string,
  ): Promise<PaymentResult>;

  /** Devuelve todo (`amountMinor` null) o una parte de un cobro. */
  refundPayment(
    collector: CollectorCredentials,
    paymentId: string,
    amountMinor: number | null,
    idempotencyKey: string,
  ): Promise<RefundResult>;

  getChargeback(
    collector: CollectorCredentials,
    chargebackId: string,
  ): Promise<ChargebackResult>;

  /** La URL a la que se manda al dueño para vincular su cuenta. */
  authorizationUrl(input: {
    state: string;
    redirectUri: string;
    codeChallenge?: string | null;
  }): string;

  exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string | null;
  }): Promise<OAuthCredentials>;

  refreshCredentials(refreshToken: string): Promise<OAuthCredentials>;

  /** Verifica la firma de un aviso. Tira si no es válida. */
  verifyNotificationSignature(input: {
    signatureHeader?: string | null;
    requestId?: string | null;
    dataId?: string | null;
  }): void;

  parseNotification(input: {
    body: unknown;
    query: Record<string, unknown>;
  }): ProcessorNotification;
}
