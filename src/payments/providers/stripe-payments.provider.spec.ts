import { StripePaymentsProvider } from "./stripe-payments.provider";

function construct(env: Record<string, string>): () => StripePaymentsProvider {
  const config = { get: (key: string) => env[key] };
  return () => new StripePaymentsProvider(config as never);
}

describe("StripePaymentsProvider live-key guard", () => {
  it("constructs with a test secret key", () => {
    const provider = construct({
      STRIPE_SECRET_KEY: "sk_test_abc123",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    })();
    expect(provider).toBeDefined();
    expect(provider.name).toBe("stripe");
  });

  it("refuses a live secret key so it can never charge real money", () => {
    expect(construct({ STRIPE_SECRET_KEY: "sk_live_abc123" })).toThrow(/test/i);
  });

  it("refuses a restricted live key", () => {
    expect(construct({ STRIPE_SECRET_KEY: "rk_live_abc123" })).toThrow(/test/i);
  });

  it("requires a secret key", () => {
    expect(construct({})).toThrow();
  });
});
