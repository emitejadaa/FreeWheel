import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  AuthedUser,
  createListing,
  createVehicle,
  futureDate,
  registerUser,
} from "./helpers/factory";
import { createIntent, payBookingFully, sendWebhook } from "./helpers/payments";

describe("Payments (Stripe flow, mocked provider)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  /** Owner + renter + an ACCEPTED booking (pricing snapshots + contract set). */
  async function acceptedBooking(): Promise<{
    owner: AuthedUser;
    renter: AuthedUser;
    bookingId: string;
    pickupToken: string;
    returnToken: string;
  }> {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    // pricePerDay 1000, 3 days => subtotal 3000, insurance 300, total 3300,
    // sena 990, balance 2310, deposit 200, ownerPayout 2700.
    const listing = await createListing(app, owner.token, vehicle.id, {
      pricePerDay: 1000,
    });
    const renter = await registerUser(app);
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId: listing.id, startDate: futureDate(5), endDate: futureDate(8) })
      .expect(201);
    const accepted = await http()
      .patch(`/bookings/${created.body.id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    return {
      owner,
      renter,
      bookingId: created.body.id,
      pickupToken: accepted.body.pickupQrToken,
      returnToken: accepted.body.returnQrToken,
    };
  }

  it("locks server-side pricing snapshots on accept", async () => {
    const { renter, bookingId } = await acceptedBooking();

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    expect(status.body.currency).toBe("usd");
    expect(status.body.total).toBe(3300);
    expect(status.body.sena).toBe(990);
    expect(status.body.balance).toBe(2310);
    expect(status.body.deposit).toBe(200);
    expect(status.body.commission).toBe(300);
    expect(status.body.insurance).toBe(300);
    expect(status.body.ownerPayout).toBe(2700);
    expect(status.body.paymentStatus).toBe("PENDING");
  });

  it("creates a seña intent with the server-computed amount in minor units", async () => {
    const { renter, bookingId } = await acceptedBooking();

    const intent = await createIntent(app, "sena", bookingId, renter.token);
    expect(intent.paymentIntentId).toMatch(/^pi_/);
    expect(intent.clientSecret).toEqual(expect.any(String));
    expect(intent.amountMinor).toBe(99000); // 990.00 USD
    expect(intent.currency).toBe("usd");
  });

  it("marks the booking DEPOSIT_PAID after the seña webhook, then FULLY_PAID after the balance", async () => {
    const { renter, bookingId } = await acceptedBooking();

    const sena = await createIntent(app, "sena", bookingId, renter.token);
    await sendWebhook(app, "payment_intent.succeeded", {
      id: sena.paymentIntentId,
      latest_charge: "ch_sena",
    }).expect(201);

    let status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(status.body.paymentStatus).toBe("DEPOSIT_PAID");

    const balance = await createIntent(app, "balance", bookingId, renter.token);
    await sendWebhook(app, "payment_intent.succeeded", {
      id: balance.paymentIntentId,
      latest_charge: "ch_balance",
    }).expect(201);

    status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(status.body.paymentStatus).toBe("FULLY_PAID");
  });

  it("refuses to create the balance intent before the seña is paid", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await http()
      .post(`/payments/bookings/${bookingId}/balance-intent`)
      .set("Authorization", auth(renter.token))
      .expect(400);
  });

  it("runs the full settlement: ready → pickup → return transfers the owner payout and releases the hold", async () => {
    const { owner, renter, bookingId, pickupToken, returnToken } =
      await acceptedBooking();

    await payBookingFully(app, bookingId, renter.token);

    await http()
      .patch(`/bookings/${bookingId}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    await http()
      .post(`/bookings/${bookingId}/confirm-pickup`)
      .set("Authorization", auth(owner.token))
      .send({ token: pickupToken })
      .expect(201);
    await http()
      .post(`/bookings/${bookingId}/confirm-return`)
      .set("Authorization", auth(renter.token))
      .send({ token: returnToken })
      .expect(201);

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    expect(status.body.ownerTransferId).toMatch(/^tr_/);
    const kinds = status.body.records.map(
      (r: { kind: string; status: string }) => `${r.kind}:${r.status}`,
    );
    expect(kinds).toContain("OWNER_TRANSFER:PAID");
    expect(kinds).toContain("DEPOSIT_HOLD:RELEASED");

    // Owner now has a connected account on file.
    const ownerRow = await prisma.user.findUnique({ where: { id: owner.id } });
    expect(ownerRow?.stripeAccountId).toMatch(/^acct_/);
  });

  it("blocks ready-for-pickup until fully paid and the deposit is authorized", async () => {
    const { owner, renter, bookingId } = await acceptedBooking();

    // Only the seña is paid.
    const sena = await createIntent(app, "sena", bookingId, renter.token);
    await sendWebhook(app, "payment_intent.succeeded", {
      id: sena.paymentIntentId,
    }).expect(201);

    await http()
      .patch(`/bookings/${bookingId}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(400);
  });

  it("rejects a webhook with an invalid signature", async () => {
    const { renter, bookingId } = await acceptedBooking();
    const sena = await createIntent(app, "sena", bookingId, renter.token);
    await http()
      .post("/payments/stripe/webhook")
      .set("Stripe-Signature", "t=1,v1=deadbeef")
      .set("Content-Type", "application/json")
      .send(
        JSON.stringify({
          id: "evt_bad",
          type: "payment_intent.succeeded",
          data: { object: { id: sena.paymentIntentId } },
        }),
      )
      .expect(400);
  });

  it("processes each webhook event id only once (idempotent)", async () => {
    const { renter, bookingId } = await acceptedBooking();
    const sena = await createIntent(app, "sena", bookingId, renter.token);

    const first = await sendWebhook(
      app,
      "payment_intent.succeeded",
      { id: sena.paymentIntentId },
      { id: "evt_dup_1" },
    ).expect(201);
    expect(first.body.duplicate).toBe(false);

    const second = await sendWebhook(
      app,
      "payment_intent.succeeded",
      { id: sena.paymentIntentId },
      { id: "evt_dup_1" },
    ).expect(201);
    expect(second.body.duplicate).toBe(true);

    const events = await prisma.stripeEvent.findMany({
      where: { eventId: "evt_dup_1" },
    });
    expect(events).toHaveLength(1);
  });

  it("forbids a non-participant from viewing payment status", async () => {
    const { bookingId } = await acceptedBooking();
    const stranger = await registerUser(app);
    await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(stranger.token))
      .expect(403);
  });

  it("refunds the captured charges when a paid booking is cancelled", async () => {
    const { owner, renter, bookingId } = await acceptedBooking();
    await payBookingFully(app, bookingId, renter.token);

    await http()
      .patch(`/bookings/${bookingId}/cancel`)
      .set("Authorization", auth(owner.token))
      .send({ reason: "owner unavailable" })
      .expect(200);

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(status.body.paymentStatus).toBe("REFUNDED");
    const kinds = status.body.records.map((r: { kind: string }) => r.kind);
    expect(kinds).toContain("REFUND");
  });

  it("lets the renter onboard nothing but the owner create a connected account", async () => {
    const { owner } = await acceptedBooking();
    const res = await http()
      .post("/payments/connect/onboarding")
      .set("Authorization", auth(owner.token))
      .expect(201);
    expect(res.body.accountId).toMatch(/^acct_/);
    expect(res.body.onboardingUrl).toEqual(expect.any(String));
  });
});
