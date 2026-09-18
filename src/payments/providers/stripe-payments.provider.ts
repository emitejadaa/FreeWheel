import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import {
  CaptureHoldInput,
  CardDetails,
  ConnectedAccountResult,
  ConnectedAccountStatus,
  CreateConnectedAccountInput,
  CreateIntentInput,
  EnsureCustomerInput,
  FailureDetails,
  PaymentIntentResult,
  PaymentProvider,
  RefundInput,
  RefundResult,
  ReleaseHoldInput,
  RiskDetails,
  TransferInput,
  TransferResult,
  WebhookEvent,
} from "./payment-provider.interface";

/**
 * EL PROVEEDOR REAL, CLAVADO EN MODO DE PRUEBA.
 *
 * Habla con Stripe de verdad: los intents son intents de Stripe, el cliente
 * paga contra Stripe, y es Stripe quien decide si el cobro pasa o se rechaza.
 * Lo único que este build no puede hacer es mover plata real: el constructor
 * se niega a arrancar con cualquier cosa que no sea una clave de test
 * (sk_test_ / rk_test_).
 *
 * ── Por qué eso importa más que un simulador ────────────────────────────────
 * Un simulador propio siempre dice que sí. Las cosas que rompen un sistema de
 * pagos en producción —una tarjeta rechazada, una que pide autenticación del
 * banco, un cobro que queda "procesando", una disputa— no se prueban contra
 * una simulación porque la simulación no las produce. En modo de prueba de
 * Stripe sí: cada uno de esos caminos tiene una tarjeta que lo dispara, y el
 * código que los atiende es exactamente el que va a correr en producción. El
 * día que esto pase a real, lo que cambia son las claves.
 *
 * Las tarjetas de prueba están documentadas en stripe.com/docs/testing; la
 * canónica de "el pago sale bien" es 4242 4242 4242 4242.
 *
 * ── Qué se le pide a Stripe además del cobro ────────────────────────────────
 * Las señas de la tarjeta (marca, últimos cuatro, país, el identificador
 * estable de ese plástico) y la evaluación de riesgo de Radar. No el número:
 * ese no pasa nunca por acá. Es lo que después permite contestar un
 * desconocimiento de cobro y ver un patrón de fraude — cinco cuentas nuevas
 * pagando con la misma tarjeta.
 */
@Injectable()
export class StripePaymentsProvider implements PaymentProvider {
  readonly name = "stripe";
  private readonly logger = new Logger(StripePaymentsProvider.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(config: ConfigService) {
    const secretKey = config.get<string>("STRIPE_SECRET_KEY");
    if (!secretKey) {
      throw new Error(
        "STRIPE_SECRET_KEY is required to use the Stripe payment provider",
      );
    }
    if (!/^(sk|rk)_test_/.test(secretKey)) {
      throw new Error(
        "Refusing to start: STRIPE_SECRET_KEY must be a Stripe TEST key " +
          "(sk_test_… / rk_test_…). Live keys are not allowed in this build.",
      );
    }
    if (!config.get<string>("STRIPE_WEBHOOK_SECRET")) {
      // No impide arrancar —se puede querer levantar la API sin webhook para
      // mirar otra cosa— pero sin esto NINGÚN cobro llega a confirmarse: el
      // aviso de Stripe se rechaza por falta de firma y la reserva se queda
      // esperando un pago que ya se hizo. Es un síntoma difícil de diagnosticar
      // y barato de anunciar.
      this.logger.warn(
        "STRIPE_WEBHOOK_SECRET no está configurado: los avisos de Stripe se " +
          "van a rechazar y ningún pago va a llegar a confirmarse.",
      );
    }

    this.webhookSecret = config.get<string>("STRIPE_WEBHOOK_SECRET") ?? "";
    // Pin the API version the SDK was built against (passing a custom string is
    // intentionally avoided to keep the typed responses in sync with the SDK).
    this.stripe = new Stripe(secretKey);
    this.logger.log("Stripe provider initialized in TEST mode");
  }

  private opts(idempotencyKey?: string): Stripe.RequestOptions | undefined {
    return idempotencyKey ? { idempotencyKey } : undefined;
  }

  private metadata(input: CreateIntentInput): Stripe.MetadataParam {
    return {
      bookingId: input.bookingId,
      kind: input.kind,
      ...(input.metadata ?? {}),
    };
  }

  async createPaymentIntent(
    input: CreateIntentInput,
  ): Promise<PaymentIntentResult> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amountMinor,
        currency: input.currency,
        customer: input.customerId ?? undefined,
        transfer_group: input.transferGroup ?? undefined,
        metadata: this.metadata(input),
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      },
      this.opts(input.idempotencyKey),
    );
    return this.toIntentResult(intent);
  }

  async createDepositHold(
    input: CreateIntentInput,
  ): Promise<PaymentIntentResult> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amountMinor,
        currency: input.currency,
        customer: input.customerId ?? undefined,
        // El depósito en garantía es una RETENCIÓN, no un cobro: la plata
        // queda bloqueada en la tarjeta y se cobra solo si hay daño. Con
        // capture_method manual, soltarla es cancelar el intent y no una
        // devolución, que es más rápido para quien alquiló y no le cuesta la
        // comisión de un reembolso.
        capture_method: "manual",
        transfer_group: input.transferGroup ?? undefined,
        metadata: this.metadata(input),
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      },
      this.opts(input.idempotencyKey),
    );
    return this.toIntentResult(intent);
  }

  async captureHold(input: CaptureHoldInput): Promise<PaymentIntentResult> {
    const intent = await this.stripe.paymentIntents.capture(
      input.paymentIntentId,
      input.amountMinor != null
        ? { amount_to_capture: input.amountMinor }
        : undefined,
      this.opts(input.idempotencyKey),
    );
    return this.toIntentResult(intent);
  }

  async releaseHold(input: ReleaseHoldInput): Promise<PaymentIntentResult> {
    const intent = await this.stripe.paymentIntents.cancel(
      input.paymentIntentId,
      undefined,
      this.opts(input.idempotencyKey),
    );
    return this.toIntentResult(intent);
  }

  /**
   * El intent con el cargo expandido, que es de donde salen la tarjeta y el
   * riesgo.
   *
   * Se expande `latest_charge` en la misma llamada en vez de hacer dos: el
   * webhook llega con el id del cargo y no con el cargo, así que sin esto el
   * registro antifraude quedaría vacío justamente en los cobros que se
   * concretaron.
   */
  async retrieveIntent(paymentIntentId: string): Promise<PaymentIntentResult> {
    const intent = await this.stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge", "latest_charge.balance_transaction"],
    });
    return this.toIntentResult(intent);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountMinor,
        reason:
          (input.reason as Stripe.RefundCreateParams.Reason | undefined) ??
          "requested_by_customer",
      },
      this.opts(input.idempotencyKey),
    );
    return {
      id: refund.id,
      amountMinor: refund.amount,
      status: refund.status ?? "unknown",
    };
  }

  async transferToOwner(input: TransferInput): Promise<TransferResult> {
    const transfer = await this.stripe.transfers.create(
      {
        amount: input.amountMinor,
        currency: input.currency,
        destination: input.destination,
        transfer_group: input.transferGroup ?? undefined,
        metadata: input.metadata,
      },
      this.opts(input.idempotencyKey),
    );
    return { id: transfer.id, amountMinor: transfer.amount };
  }

  async ensureCustomer(input: EnsureCustomerInput): Promise<string> {
    const customer = await this.stripe.customers.create({
      email: input.email,
      name: input.name ?? undefined,
      metadata: { userId: input.userId },
    });
    return customer.id;
  }

  async createConnectedAccount(
    input: CreateConnectedAccountInput,
  ): Promise<ConnectedAccountResult> {
    const account = await this.stripe.accounts.create({
      type: "express",
      email: input.email,
      metadata: { userId: input.userId },
    });

    let onboardingUrl: string | null = null;
    if (input.refreshUrl && input.returnUrl) {
      const link = await this.stripe.accountLinks.create({
        account: account.id,
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
        type: "account_onboarding",
      });
      onboardingUrl = link.url;
    }

    return { accountId: account.id, onboardingUrl };
  }

  async getConnectedAccountStatus(
    accountId: string,
  ): Promise<ConnectedAccountStatus> {
    const account = await this.stripe.accounts.retrieve(accountId);
    return {
      accountId,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      detailsSubmitted: account.details_submitted ?? false,
    };
  }

  constructWebhookEvent(
    rawBody: Buffer,
    signature: string | undefined,
  ): WebhookEvent {
    if (!signature) {
      throw new Error("Missing Stripe-Signature header");
    }
    if (!this.webhookSecret) {
      // Sin secreto no hay forma de verificar nada, y aceptar el evento igual
      // convertiría este endpoint —que es público— en "cualquiera puede
      // declarar una reserva como pagada". Se corta acá.
      throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
    }
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.webhookSecret,
    );
    return {
      id: event.id,
      type: event.type,
      data: { object: event.data.object as unknown as Record<string, unknown> },
      livemode: event.livemode,
    };
  }

  private toIntentResult(intent: Stripe.PaymentIntent): PaymentIntentResult {
    const charge =
      intent.latest_charge && typeof intent.latest_charge !== "string"
        ? intent.latest_charge
        : null;

    return {
      id: intent.id,
      clientSecret: intent.client_secret,
      status: intent.status,
      amountMinor: intent.amount,
      currency: intent.currency,
      chargeId:
        typeof intent.latest_charge === "string"
          ? intent.latest_charge
          : (charge?.id ?? null),
      amountReceivedMinor: intent.amount_received ?? null,
      amountCapturableMinor: intent.amount_capturable ?? null,
      card: charge ? cardOf(charge) : null,
      risk: charge ? riskOf(charge) : null,
      failure: failureOf(intent, charge),
    };
  }
}

/** Las señas de la tarjeta que pagó, tal como las devuelve el cargo. */
function cardOf(charge: Stripe.Charge): CardDetails | null {
  const card = charge.payment_method_details?.card;
  if (!card) return null;
  return {
    brand: card.brand ?? null,
    last4: card.last4 ?? null,
    fingerprint: card.fingerprint ?? null,
    country: card.country ?? null,
    cvcCheck: card.checks?.cvc_check ?? null,
    threeDSecure: Boolean(card.three_d_secure),
  };
}

/** Lo que Radar opinó de este cobro. */
function riskOf(charge: Stripe.Charge): RiskDetails | null {
  const outcome = charge.outcome;
  if (!outcome) return null;
  return {
    level: outcome.risk_level ?? null,
    score: outcome.risk_score ?? null,
  };
}

/**
 * Por qué falló, mirando primero el intent y después el cargo.
 *
 * Los dos lugares traen información distinta y ninguno la trae siempre: el
 * intent tiene `last_payment_error` cuando el cobro ni llegó a hacerse, y el
 * cargo tiene `failure_code` cuando se hizo y el emisor lo rechazó. Mirar uno
 * solo dejaba la mitad de los rechazos sin motivo.
 */
function failureOf(
  intent: Stripe.PaymentIntent,
  charge: Stripe.Charge | null,
): FailureDetails | null {
  const error = intent.last_payment_error;
  if (error) {
    return {
      code: error.code ?? error.type ?? null,
      message: error.message ?? null,
      declineCode: error.decline_code ?? null,
    };
  }
  if (charge?.failure_code || charge?.failure_message) {
    return {
      code: charge.failure_code ?? null,
      message: charge.failure_message ?? null,
      declineCode: charge.outcome?.reason ?? null,
    };
  }
  return null;
}
