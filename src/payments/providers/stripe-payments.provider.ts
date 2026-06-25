import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import {
  CaptureHoldInput,
  ConnectedAccountResult,
  ConnectedAccountStatus,
  CreateConnectedAccountInput,
  CreateIntentInput,
  EnsureCustomerInput,
  PaymentIntentResult,
  PaymentProvider,
  RefundInput,
  RefundResult,
  ReleaseHoldInput,
  TransferInput,
  TransferResult,
  WebhookEvent,
} from "./payment-provider.interface";

/**
 * Real Stripe provider, hard-locked to TEST mode. The constructor refuses to
 * start with anything other than a test secret key (sk_test_/rk_test_), so this
 * build can never move real money even if a live key is misconfigured.
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
        capture_method: "manual",
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
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.webhookSecret,
    );
    return {
      id: event.id,
      type: event.type,
      data: { object: event.data.object as unknown as Record<string, unknown> },
    };
  }

  private toIntentResult(intent: Stripe.PaymentIntent): PaymentIntentResult {
    return {
      id: intent.id,
      clientSecret: intent.client_secret,
      status: intent.status,
      amountMinor: intent.amount,
      currency: intent.currency,
    };
  }
}
