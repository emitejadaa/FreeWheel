/**
 * Provider-agnostic payment boundary. Both the real Stripe provider and the
 * deterministic mock provider implement this so the orchestration in
 * PaymentsService never depends on a concrete payment processor.
 *
 * All amounts are integer minor units (cents). Stripe is the reference model:
 * separate charges & transfers (the platform charges the renter and transfers
 * the owner payout on check-out), manual-capture holds for the security
 * deposit, and signed webhooks.
 *
 * ── Quién decide si un pago pasa ────────────────────────────────────────────
 * El procesador, siempre. Este backend no mira números de tarjeta —nunca los
 * recibe— ni tiene reglas propias sobre qué tarjeta vale: crea el intent, el
 * cliente paga contra Stripe, y Stripe dice si salió. Lo que este backend hace
 * con esa respuesta es registrarla entera, que es lo que después permite
 * responder un desconocimiento de cobro.
 */

export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");

export type PaymentRecordKindLike = "SENA" | "BALANCE" | "DEPOSIT_HOLD";

export interface CreateIntentInput {
  bookingId: string;
  kind: PaymentRecordKindLike;
  amountMinor: number;
  currency: string;
  customerId?: string | null;
  transferGroup?: string | null;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  /**
   * Dejar la tarjeta guardada en el cliente cuando el cobro salga bien.
   *
   * El alquiler se paga en tres tramos y cada uno es un cobro aparte. Sin
   * esto, la misma persona escribe el mismo número de tarjeta tres veces
   * seguidas en la misma pantalla, y cada vez que lo escribe es una vez más
   * que puede equivocarse o abandonar.
   *
   * No guarda ningún número acá: el procesador guarda la tarjeta contra el
   * cliente y devuelve un identificador. Es `listSavedCards` quien después la
   * encuentra.
   */
  saveCard?: boolean;
}

/**
 * UNA TARJETA QUE EL PROCESADOR YA TIENE GUARDADA, para no volver a pedirla.
 *
 * Lo único que viaja de la tarjeta son las señas que sirven para reconocerla
 * —marca, últimos cuatro, vencimiento—. El número no existe de este lado.
 *
 * `id` es el identificador que le dio el procesador. Con él se confirma un
 * cobro sin pedir la tarjeta de nuevo, y solo sirve para cobros del MISMO
 * cliente: el procesador rechaza usarlo con otro.
 */
export interface SavedCard {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/**
 * LO QUE SE SABE DE UN COBRO, en un solo lugar.
 *
 * Los campos de tarjeta y de riesgo vienen vacíos hasta que alguien paga: un
 * intent recién creado no tiene tarjeta todavía. Se llenan cuando el
 * procesador avisa que el cobro se concretó (o que falló), y es ahí cuando se
 * guardan.
 *
 * Nada de esto es un número de tarjeta. Son las señas que el procesador
 * devuelve —marca, últimos cuatro, país, y el identificador estable que le da
 * a esa tarjeta— y que permiten contestar "¿quién pagó esto?" sin que el
 * número pase nunca por este servidor.
 */
export interface PaymentIntentResult {
  id: string;
  clientSecret: string | null;
  status: string;
  amountMinor: number;
  currency: string;
  /** El cargo concreto detrás del intent, cuando ya existe. */
  chargeId?: string | null;
  /** Cuánto se cobró de verdad (una captura parcial cobra menos). */
  amountReceivedMinor?: number | null;
  /** Cuánto queda retenido y sin cobrar, en una retención. */
  amountCapturableMinor?: number | null;
  card?: CardDetails | null;
  risk?: RiskDetails | null;
  failure?: FailureDetails | null;
}

/** Las señas de la tarjeta que pagó. Nunca el número. */
export interface CardDetails {
  brand: string | null;
  last4: string | null;
  /**
   * El identificador estable que el procesador le da a UNA tarjeta: la misma
   * tarjeta en dos cuentas distintas tiene el mismo fingerprint. Es lo que
   * permite ver que cinco cuentas nuevas pagan todas con el mismo plástico,
   * que es la forma que tiene el fraude de verse desde acá.
   */
  fingerprint: string | null;
  country: string | null;
  /** Resultado de las verificaciones: "pass", "fail", "unavailable". */
  cvcCheck?: string | null;
  /** Si el pago pasó por autenticación fuerte (3-D Secure). */
  threeDSecure?: boolean | null;
}

/** Lo que el procesador opina del riesgo de este cobro. */
export interface RiskDetails {
  /** "normal", "elevated", "highest", "not_assessed". */
  level: string | null;
  /** 0-100. Más alto, más riesgoso. */
  score: number | null;
}

/** Por qué no se pudo cobrar, tal como lo dijo el procesador. */
export interface FailureDetails {
  /** "card_declined", "insufficient_funds", "expired_card"... */
  code: string | null;
  message: string | null;
  /** El motivo fino del rechazo, cuando el emisor lo da. */
  declineCode?: string | null;
}

export interface CaptureHoldInput {
  paymentIntentId: string;
  amountMinor?: number;
  idempotencyKey?: string;
}

export interface ReleaseHoldInput {
  paymentIntentId: string;
  idempotencyKey?: string;
}

export interface RefundInput {
  paymentIntentId: string;
  amountMinor?: number;
  reason?: string;
  idempotencyKey?: string;
}

export interface RefundResult {
  id: string;
  amountMinor: number;
  status: string;
}

export interface TransferInput {
  amountMinor: number;
  currency: string;
  destination: string;
  transferGroup?: string | null;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface TransferResult {
  id: string;
  amountMinor: number;
}

export interface EnsureCustomerInput {
  userId: string;
  email: string;
  name?: string | null;
}

export interface CreateConnectedAccountInput {
  userId: string;
  email: string;
  refreshUrl?: string;
  returnUrl?: string;
}

export interface ConnectedAccountResult {
  accountId: string;
  onboardingUrl: string | null;
}

export interface ConnectedAccountStatus {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface WebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  /**
   * Si el evento viene del modo real o del de prueba.
   *
   * Se mira: un evento `livemode: true` llegando a un deploy configurado en
   * test significa que algo está muy mal (claves cruzadas, un webhook apuntado
   * al proyecto equivocado) y procesarlo movería plata de verdad sobre
   * reservas de mentira.
   */
  livemode: boolean;
}

export interface PaymentProvider {
  readonly name: string;

  /** Immediate-capture intent (sena / balance). */
  createPaymentIntent(input: CreateIntentInput): Promise<PaymentIntentResult>;

  /** Manual-capture intent used as the refundable security deposit hold. */
  createDepositHold(input: CreateIntentInput): Promise<PaymentIntentResult>;

  /** Capture all or part of a previously authorized hold. */
  captureHold(input: CaptureHoldInput): Promise<PaymentIntentResult>;

  /** Release (cancel) an uncaptured hold. */
  releaseHold(input: ReleaseHoldInput): Promise<PaymentIntentResult>;

  /**
   * El estado completo de un intent, con tarjeta y riesgo ya resueltos.
   *
   * Hace falta porque el webhook NO trae esos datos: `payment_intent.succeeded`
   * manda el id del cargo, no el cargo. Sin esta llamada el registro antifraude
   * quedaría vacío justo en los cobros que se concretaron, que son los únicos
   * que alguien puede llegar a desconocer.
   */
  retrieveIntent(paymentIntentId: string): Promise<PaymentIntentResult>;

  refund(input: RefundInput): Promise<RefundResult>;

  /** Transfer the owner payout to their connected account (separate transfers). */
  transferToOwner(input: TransferInput): Promise<TransferResult>;

  ensureCustomer(input: EnsureCustomerInput): Promise<string>;

  /**
   * Las tarjetas que este cliente ya dejó guardadas, de la más nueva a la más
   * vieja. Lista vacía si no hay ninguna, que es el caso del primer cobro.
   */
  listSavedCards(customerId: string): Promise<SavedCard[]>;

  createConnectedAccount(
    input: CreateConnectedAccountInput,
  ): Promise<ConnectedAccountResult>;

  getConnectedAccountStatus(accountId: string): Promise<ConnectedAccountStatus>;

  /** Verifies the signature and returns the parsed event. Throws if invalid. */
  constructWebhookEvent(
    rawBody: Buffer,
    signature: string | undefined,
  ): WebhookEvent;
}
