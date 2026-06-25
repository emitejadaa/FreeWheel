/**
 * Provider-agnostic payment boundary. Both the real Stripe provider and the
 * deterministic mock provider implement this so the orchestration in
 * PaymentsService never depends on a concrete payment processor.
 *
 * All amounts are integer minor units (cents). Stripe is the reference model:
 * separate charges & transfers (the platform charges the renter and transfers
 * the owner payout on check-out), manual-capture holds for the security
 * deposit, and signed webhooks.
 */

export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");

export type PaymentRecordKindLike =
  | "SENA"
  | "BALANCE"
  | "DEPOSIT_HOLD";

export interface CreateIntentInput {
  bookingId: string;
  kind: PaymentRecordKindLike;
  amountMinor: number;
  currency: string;
  customerId?: string | null;
  transferGroup?: string | null;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface PaymentIntentResult {
  id: string;
  clientSecret: string | null;
  status: string;
  amountMinor: number;
  currency: string;
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

  refund(input: RefundInput): Promise<RefundResult>;

  /** Transfer the owner payout to their connected account (separate transfers). */
  transferToOwner(input: TransferInput): Promise<TransferResult>;

  ensureCustomer(input: EnsureCustomerInput): Promise<string>;

  createConnectedAccount(
    input: CreateConnectedAccountInput,
  ): Promise<ConnectedAccountResult>;

  getConnectedAccountStatus(
    accountId: string,
  ): Promise<ConnectedAccountStatus>;

  /** Verifies the signature and returns the parsed event. Throws if invalid. */
  constructWebhookEvent(
    rawBody: Buffer,
    signature: string | undefined,
  ): WebhookEvent;
}
