import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  createAdmin,
  createListing,
  createVehicle,
  futureDate,
  registerUser,
  setIdentityProfile,
} from "./helpers/factory";
import {
  documentUrls,
  FakeCloudinaryService,
} from "./helpers/cloudinary.fake";

describe("Admin", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cloudinary: FakeCloudinaryService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    ({ app, prisma, cloudinary } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
    cloudinary.reset();
  });

  it("forbids non-admins from admin routes (403)", async () => {
    const user = await registerUser(app);
    await http()
      .get("/admin/users")
      .set("Authorization", auth(user.token))
      .expect(403);
  });

  it("lists and fetches users", async () => {
    const admin = await createAdmin(app, prisma);
    const user = await registerUser(app);

    const list = await http()
      .get("/admin/users")
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(Array.isArray(list.body)).toBe(true);

    await http()
      .get(`/admin/users/${user.id}`)
      .set("Authorization", auth(admin.token))
      .expect(200);
  });

  it("suspends a user (who then cannot log in) and changes roles", async () => {
    const admin = await createAdmin(app, prisma);
    const user = await registerUser(app);

    await http()
      .patch(`/admin/users/${user.id}/status`)
      .set("Authorization", auth(admin.token))
      .send({ status: "SUSPENDED" })
      .expect(200);
    await http()
      .post("/auth/login")
      .send({ email: user.email, password: user.password })
      .expect(401);

    await http()
      .patch(`/admin/users/${user.id}/role`)
      .set("Authorization", auth(admin.token))
      .send({ role: "ADMIN" })
      .expect(200)
      .expect((res) => expect(res.body.role).toBe("ADMIN"));
  });

  it("cannot delete itself", async () => {
    const admin = await createAdmin(app, prisma);
    await http()
      .delete(`/admin/users/${admin.id}`)
      .set("Authorization", auth(admin.token))
      .expect(400);
  });

  it("lists and reviews a document verification", async () => {
    const admin = await createAdmin(app, prisma);
    const user = await registerUser(app, { verified: false });
    await setIdentityProfile(app, user.token);
    await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "dni"))
      .expect(201);

    // Un admin puede filtrar por tipo y por estado.
    const list = await http()
      .get("/admin/verifications?type=DNI")
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(list.body).toHaveLength(1);
    const verificationId = list.body[0].id;

    const detail = await http()
      .get(`/admin/verifications/${verificationId}`)
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(detail.body.type).toBe("DNI");

    // El admin sí ve las fotos, con URLs firmadas efímeras.
    const docs = await http()
      .get(`/admin/verifications/${verificationId}/documents`)
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(docs.body.documents.front).toContain("cloudinary");
  });

  it("rejects a document verification and deletes its files", async () => {
    const admin = await createAdmin(app, prisma);
    const user = await registerUser(app, { verified: false });
    await setIdentityProfile(app, user.token);
    await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "dni"))
      .expect(201);

    const list = await http()
      .get("/admin/verifications")
      .set("Authorization", auth(admin.token))
      .expect(200);

    const rejected = await http()
      .patch(`/admin/verifications/${list.body[0].id}/review`)
      .set("Authorization", auth(admin.token))
      .send({ status: "REJECTED", notes: "foto de otra persona" })
      .expect(200);

    expect(rejected.body.status).toBe("REJECTED");
    // La documentación rechazada se borra del storage y de la fila.
    expect(rejected.body.frontUrl).toBeNull();
    expect(rejected.body.backUrl).toBeNull();
    expect(cloudinary.destroyed).toHaveLength(2);
  });

  it("manages listings (status change + permanent delete)", async () => {
    const admin = await createAdmin(app, prisma);
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    const listing = await createListing(app, owner.token, vehicle.id);

    await http()
      .get("/admin/listings")
      .set("Authorization", auth(admin.token))
      .expect(200);
    await http()
      .patch(`/admin/listings/${listing.id}/status`)
      .set("Authorization", auth(admin.token))
      .send({ status: "PAUSED" })
      .expect(200);
    await http()
      .delete(`/admin/listings/${listing.id}`)
      .set("Authorization", auth(admin.token))
      .expect(200);
  });

  it("lists and fetches bookings", async () => {
    const admin = await createAdmin(app, prisma);
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    const listing = await createListing(app, owner.token, vehicle.id);
    const renter = await registerUser(app);
    const booking = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({
        listingId: listing.id,
        startDate: futureDate(5),
        endDate: futureDate(8),
      })
      .expect(201);

    const list = await http()
      .get("/admin/bookings")
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);

    await http()
      .get(`/admin/bookings/${booking.body.id}`)
      .set("Authorization", auth(admin.token))
      .expect(200);
  });

  it("permanently deletes a user", async () => {
    const admin = await createAdmin(app, prisma);
    const user = await registerUser(app);
    await http()
      .delete(`/admin/users/${user.id}`)
      .set("Authorization", auth(admin.token))
      .expect(200)
      .expect((res) => expect(res.body.deleted).toBe(true));
  });
});
