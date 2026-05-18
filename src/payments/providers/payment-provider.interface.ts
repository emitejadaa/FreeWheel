export type MockPaymentStatus = "PENDING" | "PAID" | "FAILED" | "REFUNDED";

export interface MockPaymentIntent {
  providerId: string;
  status: MockPaymentStatus;
  amount: number;
  currency: string;
  metadata: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly name: string;
  createIntent(input: {
    bookingId: string;
    amount: number;
    currency: string;
    metadata?: Record<string, unknown>;
  }): Promise<MockPaymentIntent>;
}
