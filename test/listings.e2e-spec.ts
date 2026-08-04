import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  createListing,
  createVehicle,
  futureDate,
  registerUser,
} from "./helpers/factory";

describe("Listings", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  describe("creation & ownership", () => {
    it("creates a listing for an owned vehicle", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      expect(listing.id).toEqual(expect.any(String));
    });

    it("rejects creating a listing for someone else's vehicle (403)", async () => {
      const owner = await registerUser(app);
      const other = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);

      await request(app.getHttpServer())
        .post("/listings")
        .set("Authorization", `Bearer ${other.token}`)
        .send({
          vehicleId: vehicle.id,
          title: "Trying to steal",
          description: "This should be forbidden for non-owners.",
          pricePerDay: 1000,
          locationText: "Nowhere",
        })
        .expect(403);
    });

    it("returns 404 when the vehicle does not exist", async () => {
      const owner = await registerUser(app);
      await request(app.getHttpServer())
        .post("/listings")
        .set("Authorization", `Bearer ${owner.token}`)
        .send({
          vehicleId: "00000000-0000-0000-0000-000000000000",
          title: "Ghost vehicle",
          description: "No such vehicle exists in the database.",
          pricePerDay: 1000,
          locationText: "Nowhere",
        })
        .expect(404);
    });

    it("only the owner can update or delete a listing", async () => {
      const owner = await registerUser(app);
      const other = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      await request(app.getHttpServer())
        .patch(`/listings/${listing.id}`)
        .set("Authorization", `Bearer ${other.token}`)
        .send({ pricePerDay: 9999 })
        .expect(403);

      await request(app.getHttpServer())
        .patch(`/listings/${listing.id}`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ title: "Updated title" })
        .expect(200);
    });

    it("does not let PATCH change the price (that needs the emailed code)", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      // The price is the one field that moves money on its own, so it has its
      // own confirmed flow. A plain PATCH must be refused, with an explanation.
      const res = await request(app.getHttpServer())
        .patch(`/listings/${listing.id}`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ pricePerDay: 9999 })
        .expect(400);
      expect(String(res.body.message)).toContain("Cambiar precio");
    });
  });

  describe("public catalog", () => {
    it("lists only ACTIVE listings with pagination metadata", async () => {
      const owner = await registerUser(app);
      const v1 = await createVehicle(app, owner.token, { brand: "Ford" });
      await createListing(app, owner.token, v1.id, { pricePerDay: 3000 });

      const res = await request(app.getHttpServer())
        .get("/listings")
        .expect(200);
      expect(res.body).toMatchObject({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
      expect(res.body.data).toHaveLength(1);
    });

    it("supports price/brand filters and price sorting", async () => {
      const owner = await registerUser(app);
      const cheap = await createVehicle(app, owner.token, { brand: "Fiat" });
      const pricey = await createVehicle(app, owner.token, { brand: "BMW" });
      await createListing(app, owner.token, cheap.id, { pricePerDay: 2000 });
      await createListing(app, owner.token, pricey.id, { pricePerDay: 8000 });

      const byBrand = await request(app.getHttpServer())
        .get("/listings")
        .query({ brand: "BMW" })
        .expect(200);
      expect(byBrand.body.total).toBe(1);

      const byPrice = await request(app.getHttpServer())
        .get("/listings")
        .query({ maxPrice: 3000 })
        .expect(200);
      expect(byPrice.body.total).toBe(1);

      const asc = await request(app.getHttpServer())
        .get("/listings")
        .query({ sort: "priceAsc" })
        .expect(200);
      expect(asc.body.data[0].pricePerDay).toBe(2000);
    });

    it("soft-deleted listings disappear from the catalog and 404 on detail", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      await request(app.getHttpServer())
        .delete(`/listings/${listing.id}`)
        .set("Authorization", `Bearer ${owner.token}`)
        .expect(200);

      const catalog = await request(app.getHttpServer())
        .get("/listings")
        .expect(200);
      expect(catalog.body.total).toBe(0);
      await request(app.getHttpServer())
        .get(`/listings/${listing.id}`)
        .expect(404);
    });
  });

  describe("availability & manual blocks", () => {
    it("reports availability and reflects a manual block", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      const startDate = futureDate(10);
      const endDate = futureDate(13);

      const free = await request(app.getHttpServer())
        .get(`/listings/${listing.id}/availability`)
        .query({ startDate, endDate })
        .expect(200);
      expect(free.body.available).toBe(true);

      await request(app.getHttpServer())
        .post(`/listings/${listing.id}/availability-blocks`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ startDate, endDate, reason: "Maintenance" })
        .expect(201);

      const blocked = await request(app.getHttpServer())
        .get(`/listings/${listing.id}/availability`)
        .query({ startDate, endDate })
        .expect(200);
      expect(blocked.body.available).toBe(false);
      expect(blocked.body.manualBlocks).toHaveLength(1);
    });

    it("rejects overlapping blocks and forbids non-owners", async () => {
      const owner = await registerUser(app);
      const other = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      const startDate = futureDate(20);
      const endDate = futureDate(25);

      await request(app.getHttpServer())
        .post(`/listings/${listing.id}/availability-blocks`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ startDate, endDate })
        .expect(201);

      // Overlapping block for the same listing is rejected.
      await request(app.getHttpServer())
        .post(`/listings/${listing.id}/availability-blocks`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ startDate: futureDate(22), endDate: futureDate(27) })
        .expect(400);

      // A non-owner cannot manage blocks.
      await request(app.getHttpServer())
        .get(`/listings/${listing.id}/availability-blocks`)
        .set("Authorization", `Bearer ${other.token}`)
        .expect(403);
    });
  });
});
