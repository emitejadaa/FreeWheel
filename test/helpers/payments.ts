import type { INestApplication } from "@nestjs/common";
import Stripe from "stripe";
import request from "supertest";

const WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_dummy_for_tests";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_dummy");

let evtSeq = 0;

/** Signs a Stripe event payload exactly like Stripe does (pure crypto). */
export function signWebhook(event: Record<string, unknown>): {
  payload: string;
  signature: string;
} {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { payload, signature };
}

/** Posts a signed webhook to the app. Returns the supertest Test (chainable). */
export function sendWebhook(
  app: INestApplication,
  type: string,
  object: Record<string, unknown>,
  opts: { id?: string; signature?: string; payload?: string } = {},
) {
  evtSeq += 1;
  const event = {
    id: opts.id ?? `evt_test_${Date.now()}_${evtSeq}`,
    type,
    data: { object },
  };
  const signed = signWebhook(event);
  const payload = opts.payload ?? signed.payload;
  const signature = opts.signature ?? signed.signature;
  return request(app.getHttpServer())
    .post("/payments/stripe/webhook")
    .set("Stripe-Signature", signature)
    .set("Content-Type", "application/json")
    .send(payload);
}

type IntentKind = "sena" | "balance" | "deposit";

const PATHS: Record<IntentKind, string> = {
  sena: "sena-intent",
  balance: "balance-intent",
  deposit: "deposit-hold",
};

export async function createIntent(
  app: INestApplication,
  kind: IntentKind,
  bookingId: string,
  token: string,
): Promise<{
  paymentIntentId: string;
  clientSecret: string | null;
  amountMinor: number;
  currency: string;
}> {
  const res = await request(app.getHttpServer())
    .post(`/payments/bookings/${bookingId}/${PATHS[kind]}`)
    .set("Authorization", `Bearer ${token}`)
    .expect(201);
  return res.body;
}

/** Drives a booking through seña + balance + authorized deposit hold. */
export async function payBookingFully(
  app: INestApplication,
  bookingId: string,
  token: string,
): Promise<{
  sena: { paymentIntentId: string };
  balance: { paymentIntentId: string };
  hold: { paymentIntentId: string };
}> {
  const sena = await createIntent(app, "sena", bookingId, token);
  await sendWebhook(app, "payment_intent.succeeded", {
    id: sena.paymentIntentId,
    latest_charge: "ch_test_sena",
  }).expect(201);

  const balance = await createIntent(app, "balance", bookingId, token);
  await sendWebhook(app, "payment_intent.succeeded", {
    id: balance.paymentIntentId,
    latest_charge: "ch_test_balance",
  }).expect(201);

  const hold = await createIntent(app, "deposit", bookingId, token);
  await sendWebhook(app, "payment_intent.amount_capturable_updated", {
    id: hold.paymentIntentId,
  }).expect(201);

  return { sena, balance, hold };
}
