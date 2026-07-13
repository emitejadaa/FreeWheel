import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  bearer,
  createListing,
  createVehicle,
  futureDate,
  registerUser,
} from "./helpers/factory";

/**
 * The verified-account gate: sensitive mutations require a fully verified
 * account (VERIFIED), while browsing, messaging, profile and the verification
 * endpoints themselves stay open to any authenticated user.
 */
describe("Verified-account gate", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  describe("blocks sensitive routes for an unverified account", () => {
    it("returns 403 ACCOUNT_NOT_VERIFIED on gated mutations", async () => {
      const user = await registerUser(app, { verified: false });
      const t = bearer(user.token);

      const expectGated = (res: request.Response) => {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("ACCOUNT_NOT_VERIFIED");
      };

      expectGated(
        await http()
          .post("/vehicles")
          .set("Authorization", t)
          .send({ brand: "Toyota", model: "Corolla", year: 2020 }),
      );
      expectGated(
        await http()
          .post("/listings")
          .set("Authorization", t)
          .send({
            vehicleId: "00000000-0000-0000-0000-000000000000",
            title: "x",
            description: "y",
            pricePerDay: 5000,
            locationText: "CABA",
          }),
      );
      expectGated(
        await http()
          .post("/bookings")
          .set("Authorization", t)
          .send({
            listingId: "00000000-0000-0000-0000-000000000000",
            startDate: futureDate(3),
            endDate: futureDate(6),
          }),
      );
      expectGated(
        await http()
          .post("/contracts/bookings/00000000-0000-0000-0000-000000000000/accept")
          .set("Authorization", t),
      );
      expectGated(
        await http()
          .post("/payments/bookings/00000000-0000-0000-0000-000000000000/sena-intent")
          .set("Authorization", t),
      );
    });
  });

  describe("allows low-risk routes for an unverified account", () => {
    it("permits browsing, profile, conversations and verification endpoints", async () => {
      const user = await registerUser(app, { verified: false });
      const t = bearer(user.token);

      await http().get("/listings").expect(200);
      await http().get("/users/me").set("Authorization", t).expect(200);
      await http().get("/bookings/me").set("Authorization", t).expect(200);
      await http().get("/conversations/me").set("Authorization", t).expect(200);
      await http()
        .get("/verification/me/status")
        .set("Authorization", t)
        .expect(200);

      // The media signature endpoint is needed to upload the verification docs,
      // so it must NOT be gated (it may fail on config, but never with 403).
      const sig = await http()
        .post("/media/cloudinary-signature")
        .set("Authorization", t)
        .send({ folder: "identity" });
      expect(sig.status).not.toBe(403);
    });
  });

  describe("allows sensitive routes once fully verified", () => {
    it("lets a verified account create a vehicle and a listing", async () => {
      const owner = await registerUser(app); // verified by default
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      expect(listing.id).toEqual(expect.any(String));
    });
  });
});
