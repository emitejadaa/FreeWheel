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

describe("Payments (mock)", () => {
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

  /** A booking in ACCEPTED state (a PENDING mock payment exists after accept). */
  async function acceptedBooking(): Promise<{
    owner: AuthedUser;
    renter: AuthedUser;
    bookingId: string;
  }> {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    const listing = await createListing(app, owner.token, vehicle.id);
    const renter = await registerUser(app);
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId: listing.id, startDate: futureDate(5), endDate: futureDate(8) })
      .expect(201);
    await http()
      .patch(`/bookings/${created.body.id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    return { owner, renter, bookingId: created.body.id };
  }

  it("confirms and refunds a mock payment, reflecting status", async () => {
    const { renter, bookingId } = await acceptedBooking();

    const intent = await http()
      .post(`/payments/bookings/${bookingId}/mock-intent`)
      .set("Authorization", auth(renter.token))
      .expect(201);
    expect(intent.body.status).toBe("PENDING");

    await http()
      .post(`/payments/bookings/${bookingId}/mock-confirm`)
      .set("Authorization", auth(renter.token))
      .expect(201)
      .expect((res) => expect(res.body.status).toBe("PAID"));

    const paid = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(paid.body.paymentStatus).toBe("PAID");
    expect(paid.body.records.length).toBeGreaterThanOrEqual(1);

    await http()
      .post(`/payments/bookings/${bookingId}/mock-refund`)
      .set("Authorization", auth(renter.token))
      .expect(201)
      .expect((res) => expect(res.body.status).toBe("REFUNDED"));
  });

  it("forbids a non-participant from viewing payment status", async () => {
    const { bookingId } = await acceptedBooking();
    const stranger = await registerUser(app);
    await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(stranger.token))
      .expect(403);
  });

  it("processes a mock webhook (public) and marks the booking paid", async () => {
    const { renter, bookingId } = await acceptedBooking();

    await http()
      .post("/payments/mock/webhook")
      .send({ bookingId, type: "mock.payment.confirmed" })
      .expect(201);

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(status.body.paymentStatus).toBe("PAID");
  });
});
