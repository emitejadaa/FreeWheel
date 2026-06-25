import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
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
 * Deterministic, offline implementation of the payment boundary. Used for local
 * development and as the E2E provider (no network). Money never moves.
 *
 * Webhook signatures are verified for real (Stripe's signature scheme is pure
 * crypto, no network) whenever STRIPE_WEBHOOK_SECRET is configured, so the
 * webhook security path is exercised exactly like production.
 */
@Injectable()
export class MockPaymentsProvider implements PaymentProvider {
  readonly name = "mock";
  private readonly webhookSecret: string;
  private readonly stripe: Stripe;

  constructor(config: ConfigService) {
    this.webhookSecret = config.get<string>("STRIPE_WEBHOOK_SECRET") ?? "";
    // Key-independent: only used for the offline signature helpers.
    this.stripe = new Stripe(
      config.get<string>("STRIPE_SECRET_KEY") ?? "sk_test_mock",
    );
  }

  private id(prefix: string): string {
    return `${prefix}_${randomBytes(12).toString("hex")}`;
  }

  createPaymentIntent(input: CreateIntentInput): Promise<PaymentIntentResult> {
    const id = this.id(`pi_mock_${input.kind.toLowerCase()}`);
    return Promise.resolve({
      id,
      clientSecret: `${id}_secret_${randomBytes(6).toString("hex")}`,
      status: "requires_payment_method",
      amountMinor: input.amountMinor,
      currency: input.currency,
    });
  }

  createDepositHold(input: CreateIntentInput): Promise<PaymentIntentResult> {
    const id = this.id("pi_mock_deposit");
    return Promise.resolve({
      id,
      clientSecret: `${id}_secret_${randomBytes(6).toString("hex")}`,
      status: "requires_payment_method",
      amountMinor: input.amountMinor,
      currency: input.currency,
    });
  }

  captureHold(input: CaptureHoldInput): Promise<PaymentIntentResult> {
    return Promise.resolve({
      id: input.paymentIntentId,
      clientSecret: null,
      status: "succeeded",
      amountMinor: input.amountMinor ?? 0,
      currency: "usd",
    });
  }

  releaseHold(input: ReleaseHoldInput): Promise<PaymentIntentResult> {
    return Promise.resolve({
      id: input.paymentIntentId,
      clientSecret: null,
      status: "canceled",
      amountMinor: 0,
      currency: "usd",
    });
  }

  refund(input: RefundInput): Promise<RefundResult> {
    return Promise.resolve({
      id: this.id("re_mock"),
      amountMinor: input.amountMinor ?? 0,
      status: "succeeded",
    });
  }

  transferToOwner(input: TransferInput): Promise<TransferResult> {
    return Promise.resolve({
      id: this.id("tr_mock"),
      amountMinor: input.amountMinor,
    });
  }

  ensureCustomer(input: EnsureCustomerInput): Promise<string> {
    return Promise.resolve(`cus_mock_${input.userId.replace(/-/g, "").slice(0, 16)}`);
  }

  createConnectedAccount(
    input: CreateConnectedAccountInput,
  ): Promise<ConnectedAccountResult> {
    return Promise.resolve({
      accountId: `acct_mock_${input.userId.replace(/-/g, "").slice(0, 16)}`,
      onboardingUrl:
        input.returnUrl ?? "https://mock.stripe.local/connect/onboarding",
    });
  }

  getConnectedAccountStatus(
    accountId: string,
  ): Promise<ConnectedAccountStatus> {
    return Promise.resolve({
      accountId,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
  }

  constructWebhookEvent(
    rawBody: Buffer,
    signature: string | undefined,
  ): WebhookEvent {
    if (this.webhookSecret && signature) {
      const event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
      );
      return {
        id: event.id,
        type: event.type,
        data: {
          object: event.data.object as unknown as Record<string, unknown>,
        },
      };
    }

    // Lenient path for local dev without a configured signing secret.
    const parsed = JSON.parse(rawBody.toString("utf8")) as {
      id?: string;
      type?: string;
      data?: { object?: Record<string, unknown> };
    };
    return {
      id: parsed.id ?? this.id("evt_mock"),
      type: parsed.type ?? "unknown",
      data: { object: parsed.data?.object ?? {} },
    };
  }
}
