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

describe("Contracts", () => {
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

  async function acceptedBooking(): Promise<{
    owner: AuthedUser;
    renter: AuthedUser;
    bookingId: string;
  }> {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    const listing = await createListing(app, owner.token, vehicle.id, {
      pricePerDay: 1000,
    });
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

  it("creates the contract on accept with the full money breakdown for both parties", async () => {
    const { owner, renter, bookingId } = await acceptedBooking();

    for (const user of [owner, renter]) {
      const res = await http()
        .get(`/contracts/bookings/${bookingId}`)
        .set("Authorization", auth(user.token))
        .expect(200);
      expect(res.body.status).toBe("PENDING_ACCEPTANCE");
      expect(res.body.terms.total).toBe(3300);
      expect(res.body.terms.sena).toBe(990);
      expect(res.body.terms.deposit).toBe(200);
      expect(res.body.terms.commission).toBe(300);
      expect(res.body.terms.ownerPayout).toBe(2700);
    }
  });

  it("serves the contract as a PDF to a participant", async () => {
    const { renter, bookingId } = await acceptedBooking();
    const res = await http()
      .get(`/contracts/bookings/${bookingId}/pdf`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const pdf = res.body as Buffer;
    expect(pdf.length).toBeGreaterThan(500);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("marks the contract ACCEPTED only once both parties accept", async () => {
    const { owner, renter, bookingId } = await acceptedBooking();

    const first = await http()
      .post(`/contracts/bookings/${bookingId}/accept`)
      .set("Authorization", auth(renter.token))
      .expect(201);
    expect(first.body.status).toBe("PENDING_ACCEPTANCE");
    expect(first.body.renterAcceptedAt).toEqual(expect.any(String));

    const second = await http()
      .post(`/contracts/bookings/${bookingId}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(201);
    expect(second.body.status).toBe("ACCEPTED");
    expect(second.body.ownerAcceptedAt).toEqual(expect.any(String));
  });

  it("forbids a non-participant from reading the contract", async () => {
    const { bookingId } = await acceptedBooking();
    const stranger = await registerUser(app);
    await http()
      .get(`/contracts/bookings/${bookingId}`)
      .set("Authorization", auth(stranger.token))
      .expect(403);
  });
});
