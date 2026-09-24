import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { signMercadoPagoNotification } from "../../src/payments/providers/mercadopago/mercadopago.shared";
import { PAYMENT_PROVIDER } from "../../src/payments/providers/payment-provider.interface";
import type { MockPaymentsProvider } from "../../src/payments/providers/mock-payments.provider";

const WEBHOOK_SECRET =
  process.env.MP_WEBHOOK_SECRET ?? "mp_webhook_secret_for_tests";

let seq = 0;

/** El provider de pruebas, para cambiar cosas "del lado de Mercado Pago". */
export function mercadoPago(app: INestApplication): MockPaymentsProvider {
  return app.get(PAYMENT_PROVIDER);
}

/**
 * LA TARJETA, COMO LA ARMA EL FORMULARIO DE MERCADO PAGO.
 *
 * El resultado lo decide el "titular", igual que en el sandbox: APRO se
 * aprueba, FUND no tiene fondos, CONT queda en revisión, etc. (ver
 * MockPaymentsProvider). Cada llamada arma un token nuevo, como el formulario.
 */
export function tarjeta(titular = "APRO", extra: Record<string, unknown> = {}) {
  seq += 1;
  return {
    token: `tok_${titular}_${Date.now().toString(36)}${seq}`,
    payment_method_id: "visa",
    issuer_id: "310",
    installments: 1,
    transaction_amount: 1, // el Brick lo manda; el servidor lo ignora
    payer: {
      email: "comprador@test.com",
      identification: { type: "DNI", number: "12345678" },
    },
    ...extra,
  };
}

/**
 * Manda un aviso firmado como lo firma Mercado Pago. `firma` permite mandar
 * uno con una firma mala.
 */
export function sendNotification(
  app: INestApplication,
  topic: string,
  dataId: string,
  opts: {
    action?: string;
    userId?: string | null;
    liveMode?: boolean;
    notificationId?: string;
    firma?: string;
  } = {},
) {
  seq += 1;
  const requestId = `req-${Date.now()}-${seq}`;
  const firma =
    opts.firma ??
    signMercadoPagoNotification({
      secret: WEBHOOK_SECRET,
      dataId,
      requestId,
    });
  return request(app.getHttpServer())
    .post(
      `/payments/mercadopago/webhook?data.id=${encodeURIComponent(dataId)}&type=${topic}`,
    )
    .set("x-signature", firma)
    .set("x-request-id", requestId)
    .send({
      id: opts.notificationId ?? `${Date.now()}${seq}`,
      type: topic,
      action: opts.action ?? `${topic}.updated`,
      data: { id: dataId },
      user_id: opts.userId ?? undefined,
      live_mode: opts.liveMode ?? false,
    });
}

/**
 * VINCULA LA CUENTA DE MERCADO PAGO DE UN DUEÑO, por el camino de verdad:
 * pide la URL de vinculación, saca el `state` y vuelve por el callback con un
 * código, como hace Mercado Pago. Devuelve el user_id de Mercado Pago.
 */
export async function linkOwnerMercadoPago(
  app: INestApplication,
  owner: { id: string; token: string },
): Promise<string> {
  const inicio = await request(app.getHttpServer())
    .post("/payments/connect/onboarding")
    .set("Authorization", `Bearer ${owner.token}`)
    .expect(201);
  const state = new URL(inicio.body.onboardingUrl as string).searchParams.get(
    "state",
  );
  const code = `codigo${owner.id.replace(/-/g, "").slice(0, 16)}`;
  const vuelta = await request(app.getHttpServer())
    .get("/payments/mercadopago/oauth/callback")
    .query({ code, state })
    .expect(302);
  if (!String(vuelta.headers.location).includes("status=ok")) {
    throw new Error(`La vinculación falló: ${vuelta.headers.location}`);
  }
  return `mp_user_${code}`;
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

/** Paga la reserva con una tarjeta (por omisión, una que se aprueba). */
export async function checkout(
  app: INestApplication,
  bookingId: string,
  token: string,
  titular = "APRO",
) {
  const res = await request(app.getHttpServer())
    .post(`/payments/bookings/${bookingId}/checkout`)
    .set("Authorization", `Bearer ${token}`)
    .send(tarjeta(titular))
    .expect(201);
  return res.body as {
    paymentId: string;
    status: string;
    statusDetail: string | null;
    approved: boolean;
    message: string | null;
    bookingPaymentStatus: string;
  };
}

/**
 * DEJA LA RESERVA PAGA, como la deja una persona en el front: firma el
 * contrato y paga con una tarjeta que se aprueba. Con Mercado Pago el
 * resultado llega en la misma respuesta: no hace falta esperar un aviso.
 */
export async function payBookingFully(
  app: INestApplication,
  bookingId: string,
  token: string,
): Promise<{ checkout: { paymentId: string } }> {
  await acceptContract(app, bookingId, token);
  const pago = await checkout(app, bookingId, token);
  if (!pago.approved) {
    throw new Error(`El pago de prueba no se aprobó: ${pago.statusDetail}`);
  }
  return { checkout: pago };
}

/**
 * Autoriza el depósito en garantía (una reserva de fondos). Las pruebas lo
 * hacen sobre reservas que empiezan pronto, dentro de la ventana en que se
 * habilita.
 */
export async function authorizeDeposit(
  app: INestApplication,
  bookingId: string,
  token: string,
  titular = "APRO",
) {
  const res = await request(app.getHttpServer())
    .post(`/payments/bookings/${bookingId}/deposit-hold`)
    .set("Authorization", `Bearer ${token}`)
    .send(tarjeta(titular))
    .expect(201);
  return res.body as { paymentId: string; status: string; approved: boolean };
}
