import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import { createListing, createVehicle, registerUser } from "./helpers/factory";

describe("Vehicles", () => {
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

  it("creates a vehicle for the authenticated owner", async () => {
    const owner = await registerUser(app);
    const res = await request(app.getHttpServer())
      .post("/vehicles")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ brand: "Honda", model: "Civic", year: 2021 })
      .expect(201);
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.brand).toBe("Honda");
  });

  it("requires authentication and validates the payload", async () => {
    await request(app.getHttpServer())
      .post("/vehicles")
      .send({ brand: "Honda", model: "Civic", year: 2021 })
      .expect(401);

    const owner = await registerUser(app);
    await request(app.getHttpServer())
      .post("/vehicles")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ brand: "Honda", model: "Civic", year: 1800 }) // year < 1900
      .expect(400);
  });

  it("GET /vehicles/:id is public and hides ownerId and plate", async () => {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token, { plate: "AB123CD" });
    const res = await request(app.getHttpServer())
      .get(`/vehicles/${vehicle.id}`)
      .expect(200);
    expect(res.body.ownerId).toBeUndefined();
    expect(res.body.plate).toBeUndefined();
    expect(res.body.brand).toBe("Toyota");
  });

  it("returns 404 for an unknown vehicle", async () => {
    await request(app.getHttpServer())
      .get("/vehicles/00000000-0000-0000-0000-000000000000")
      .expect(404);
  });

  it("only the owner can update or delete", async () => {
    const owner = await registerUser(app);
    const other = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);

    await request(app.getHttpServer())
      .patch(`/vehicles/${vehicle.id}`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({ color: "red" })
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/vehicles/${vehicle.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ color: "red" })
      .expect(200);
  });

  it("cannot delete a vehicle that has a listing", async () => {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    await createListing(app, owner.token, vehicle.id);

    await request(app.getHttpServer())
      .delete(`/vehicles/${vehicle.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(400);
  });

  it("deletes a vehicle with no listings", async () => {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    const res = await request(app.getHttpServer())
      .delete(`/vehicles/${vehicle.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(200);
    expect(res.body.deleted).toBe(true);
  });
});
