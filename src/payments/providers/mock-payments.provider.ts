import { Injectable } from "@nestjs/common";
import { randomBytes } from "crypto";
import {
  MockPaymentIntent,
  PaymentProvider,
} from "./payment-provider.interface";

@Injectable()
export class MockPaymentsProvider implements PaymentProvider {
  readonly name = "mock";

  createIntent(input: {
    bookingId: string;
    amount: number;
    currency: string;
    metadata?: Record<string, unknown>;
  }): Promise<MockPaymentIntent> {
    return Promise.resolve({
      providerId: `mock_${randomBytes(12).toString("hex")}`,
      status: "PENDING",
      amount: input.amount,
      currency: input.currency,
      metadata: {
        bookingId: input.bookingId,
        ...input.metadata,
      },
    });
  }
}
