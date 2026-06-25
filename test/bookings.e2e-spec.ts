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
import { payBookingFully } from "./helpers/payments";

describe("Bookings", () => {
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

  /** Owner with an ACTIVE listing + a separate renter. */
  async function setup(): Promise<{
    owner: AuthedUser;
    renter: AuthedUser;
    listingId: string;
  }> {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    const listing = await createListing(app, owner.token, vehicle.id);
    const renter = await registerUser(app);
    return { owner, renter, listingId: listing.id };
  }

  const dates = (offset: number) => ({
    startDate: futureDate(offset),
    endDate: futureDate(offset + 3),
  });

  it("runs the full lifecycle: request → accept → pay → ready → pickup → return → COMPLETED", async () => {
    const { owner, renter, listingId } = await setup();

    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(5) })
      .expect(201);
    expect(created.body.status).toBe("REQUESTED");
    const id = created.body.id;

    const accepted = await http()
      .patch(`/bookings/${id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    expect(accepted.body.status).toBe("ACCEPTED");
    const pickupToken = accepted.body.pickupQrToken;
    const returnToken = accepted.body.returnQrToken;
    expect(pickupToken).toEqual(expect.any(String));
    expect(returnToken).toEqual(expect.any(String));

    await payBookingFully(app, id, renter.token);

    const ready = await http()
      .patch(`/bookings/${id}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    expect(ready.body.status).toBe("READY_FOR_PICKUP");

    const pickedUp = await http()
      .post(`/bookings/${id}/confirm-pickup`)
      .set("Authorization", auth(owner.token))
      .send({ token: pickupToken })
      .expect(201);
    expect(pickedUp.body.status).toBe("IN_PROGRESS");

    const returned = await http()
      .post(`/bookings/${id}/confirm-return`)
      .set("Authorization", auth(renter.token))
      .send({ token: returnToken })
      .expect(201);
    expect(returned.body.status).toBe("COMPLETED");
  });

  it("cannot mark ready for pickup before payment is confirmed", async () => {
    const { owner, renter, listingId } = await setup();
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(30) })
      .expect(201);
    await http()
      .patch(`/bookings/${created.body.id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    // Payment still PENDING → cannot advance.
    await http()
      .patch(`/bookings/${created.body.id}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(400);
  });

  it("forbids booking your own listing", async () => {
    const { owner, listingId } = await setup();
    await http()
      .post("/bookings")
      .set("Authorization", auth(owner.token))
      .send({ listingId, ...dates(5) })
      .expect(403);
  });

  it("rejects invalid date ranges", async () => {
    const { renter, listingId } = await setup();
    // Start date in the past.
    await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({
        listingId,
        startDate: new Date(Date.now() - 86_400_000).toISOString(),
        endDate: futureDate(3),
      })
      .expect(400);
    // End before start.
    await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, startDate: futureDate(5), endDate: futureDate(4) })
      .expect(400);
  });

  it("prevents a second booking that overlaps an accepted one", async () => {
    const { owner, renter, listingId } = await setup();
    const range = dates(8);
    const first = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...range })
      .expect(201);
    await http()
      .patch(`/bookings/${first.body.id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);

    const renter2 = await registerUser(app);
    await http()
      .post("/bookings")
      .set("Authorization", auth(renter2.token))
      .send({ listingId, ...range })
      .expect(400);
  });

  it("enforces participant and owner-only guards", async () => {
    const { renter, listingId } = await setup();
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(12) })
      .expect(201);
    const id = created.body.id;
    const stranger = await registerUser(app);

    await http()
      .get(`/bookings/${id}`)
      .set("Authorization", auth(stranger.token))
      .expect(403);
    await http()
      .patch(`/bookings/${id}/accept`)
      .set("Authorization", auth(renter.token))
      .expect(403);
  });

  it("rejects an invalid pickup token", async () => {
    const { owner, renter, listingId } = await setup();
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(15) })
      .expect(201);
    const id = created.body.id;
    await http()
      .patch(`/bookings/${id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    await payBookingFully(app, id, renter.token);
    await http()
      .patch(`/bookings/${id}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    await http()
      .post(`/bookings/${id}/confirm-pickup`)
      .set("Authorization", auth(owner.token))
      .send({ token: "z".repeat(48) })
      .expect(403);
  });

  it("owner can reject a requested booking", async () => {
    const { owner, renter, listingId } = await setup();
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(18) })
      .expect(201);
    const rejected = await http()
      .patch(`/bookings/${created.body.id}/reject`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    expect(rejected.body.status).toBe("REJECTED");
  });

  it("cancels a paid booking and shows it under /bookings/me", async () => {
    const { owner, renter, listingId } = await setup();
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(21) })
      .expect(201);
    const id = created.body.id;
    await http()
      .patch(`/bookings/${id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    await payBookingFully(app, id, renter.token);
    const cancelled = await http()
      .patch(`/bookings/${id}/cancel`)
      .set("Authorization", auth(renter.token))
      .send({ reason: "Changed plans" })
      .expect(200);
    expect(cancelled.body.status).toBe("CANCELLED_BY_RENTER");

    const mine = await http()
      .get("/bookings/me")
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(mine.body.length).toBeGreaterThanOrEqual(1);
  });
});
