import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import { registerUser } from "./helpers/factory";

describe("Users", () => {
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

  it("GET /users/me returns the profile without the password", async () => {
    const user = await registerUser(app);
    const res = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${user.token}`)
      .expect(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body.email).toBe(user.email);
    expect(res.body.password).toBeUndefined();
  });

  it("GET /users/me requires a token", async () => {
    await request(app.getHttpServer()).get("/users/me").expect(401);
  });

  it("PATCH /users/me updates allowed fields", async () => {
    const user = await registerUser(app);
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ firstName: "Grace", phone: "+5491133334444" })
      .expect(200);
    expect(res.body.firstName).toBe("Grace");
    expect(res.body.phone).toBe("+5491133334444");
  });

  it("PATCH /users/me rejects an invalid profile photo URL", async () => {
    const user = await registerUser(app);
    await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ profilePhotoUrl: "not-a-url" })
      .expect(400);
  });
});
