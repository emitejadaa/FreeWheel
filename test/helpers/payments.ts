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
  opts: {
    id?: string;
    signature?: string;
    payload?: string;
    /** Para probar que un evento del modo REAL se descarta acá. */
    livemode?: boolean;
  } = {},
) {
  evtSeq += 1;
  const event = {
    id: opts.id ?? `evt_test_${Date.now()}_${evtSeq}`,
    type,
    data: { object },
    livemode: opts.livemode ?? false,
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

type IntentKind = "checkout" | "sena" | "balance" | "deposit";

const PATHS: Record<IntentKind, string> = {
  checkout: "checkout",
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

/** Quien alquila firma el contrato. Sin esto, el cobro se niega con 409. */
export async function acceptContract(
  app: INestApplication,
  bookingId: string,
  token: string,
): Promise<void> {
  await request(app.getHttpServer())
    .post(`/contracts/bookings/${bookingId}/accept`)
    .set("Authorization", `Bearer ${token}`)
    .expect(201);
}

/**
 * DEJA LA RESERVA PAGA, como la deja una persona en el front.
 *
 * Son tres pasos y ninguno sobra:
 *   1. firmar el contrato (el cobro se niega si no está firmado);
 *   2. crear el cobro único —alquiler + cobertura, todo junto—;
 *   3. avisar que Stripe lo confirmó, que es lo que de verdad marca la
 *      reserva como pagada. Sin el webhook, crear el intent no cobró nada.
 *
 * El depósito en garantía NO se pide acá: se autoriza solo, sin el cliente
 * presente, cuando el dueño marca el auto listo para entregar, usando la
 * tarjeta que quedó guardada en el paso 2.
 */
export async function payBookingFully(
  app: INestApplication,
  bookingId: string,
  token: string,
): Promise<{ checkout: { paymentIntentId: string } }> {
  await acceptContract(app, bookingId, token);

  const checkout = await createIntent(app, "checkout", bookingId, token);
  await sendWebhook(app, "payment_intent.succeeded", {
    id: checkout.paymentIntentId,
    latest_charge: "ch_test_checkout",
  }).expect(201);

  return { checkout };
}
