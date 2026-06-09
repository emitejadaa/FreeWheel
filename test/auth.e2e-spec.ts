import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { FakeEmailService } from "./helpers/email.fake";
import { PrismaService } from "../src/prisma/prisma.service";
import { registerUser, uniqueEmail, TEST_PASSWORD } from "./helpers/factory";

describe("Auth", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let email: FakeEmailService;

  beforeAll(async () => {
    ({ app, prisma, email } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  const validBody = () => ({
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    firstName: "Ada",
    lastName: "Lovelace",
    acceptedTerms: true,
  });

  describe("POST /auth/register", () => {
    it("creates a user and returns a token without leaking the password", async () => {
      const body = validBody();
      const res = await request(app.getHttpServer())
        .post("/auth/register")
        .send(body)
        .expect(201);

      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.emailVerificationRequired).toBe(true);
      expect(res.body.user.email).toBe(body.email);
      expect(res.body.user.password).toBeUndefined();
    });

    it("rejects a duplicate email with 409", async () => {
      const body = validBody();
      await request(app.getHttpServer()).post("/auth/register").send(body).expect(201);
      await request(app.getHttpServer()).post("/auth/register").send(body).expect(409);
    });

    it("rejects invalid payloads with 400", async () => {
      await request(app.getHttpServer())
        .post("/auth/register")
        .send({ ...validBody(), email: "not-an-email" })
        .expect(400);
      await request(app.getHttpServer())
        .post("/auth/register")
        .send({ ...validBody(), password: "123" })
        .expect(400);
      await request(app.getHttpServer())
        .post("/auth/register")
        .send({ ...validBody(), acceptedTerms: false })
        .expect(400);
      // Unknown field rejected by forbidNonWhitelisted.
      await request(app.getHttpServer())
        .post("/auth/register")
        .send({ ...validBody(), role: "ADMIN" })
        .expect(400);
    });
  });

  describe("POST /auth/login", () => {
    it("logs in with correct credentials", async () => {
      const user = await registerUser(app);
      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: user.email, password: user.password })
        .expect(201);
      expect(res.body.accessToken).toEqual(expect.any(String));
    });

    it("rejects a wrong password and an unknown email with 401", async () => {
      const user = await registerUser(app);
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: user.email, password: "WrongPass123!" })
        .expect(401);
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: uniqueEmail(), password: TEST_PASSWORD })
        .expect(401);
    });
  });

  describe("Email verification", () => {
    it("verifies the email with the emailed code", async () => {
      const user = await registerUser(app);
      const code = email.lastCode(user.email);
      expect(code).toMatch(/^\d{6}$/);

      await request(app.getHttpServer())
        .post("/auth/verify-email")
        .set("Authorization", `Bearer ${user.token}`)
        .send({ code })
        .expect(201)
        .expect((res) => {
          expect(res.body.message).toBe("Email verified successfully");
        });
    });

    it("rejects a wrong code with 400", async () => {
      const user = await registerUser(app);
      await request(app.getHttpServer())
        .post("/auth/verify-email")
        .set("Authorization", `Bearer ${user.token}`)
        .send({ code: "000000" })
        .expect(400);
    });

    it("requires authentication", async () => {
      await request(app.getHttpServer())
        .post("/auth/verify-email")
        .send({ code: "123456" })
        .expect(401);
    });
  });

  describe("Password reset", () => {
    it("is enumeration-safe (same reply for known and unknown emails)", async () => {
      const user = await registerUser(app);
      const known = await request(app.getHttpServer())
        .post("/auth/forgot-password")
        .send({ email: user.email })
        .expect(201);
      const unknown = await request(app.getHttpServer())
        .post("/auth/forgot-password")
        .send({ email: uniqueEmail() })
        .expect(201);
      expect(known.body.message).toBe(unknown.body.message);
    });

    it("resets the password with the emailed token, then login uses the new password", async () => {
      const user = await registerUser(app);
      await request(app.getHttpServer())
        .post("/auth/forgot-password")
        .send({ email: user.email })
        .expect(201);
      const token = email.lastResetToken(user.email);
      expect(token).toEqual(expect.any(String));

      const newPassword = "BrandNewPass456!";
      await request(app.getHttpServer())
        .post("/auth/reset-password")
        .send({ token, userId: user.id, newPassword })
        .expect(201);

      // New password works, old one no longer does.
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: user.email, password: newPassword })
        .expect(201);
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: user.email, password: user.password })
        .expect(401);
    });

    it("rejects an invalid reset token with 400", async () => {
      const user = await registerUser(app);
      await request(app.getHttpServer())
        .post("/auth/forgot-password")
        .send({ email: user.email })
        .expect(201);
      await request(app.getHttpServer())
        .post("/auth/reset-password")
        .send({ token: "wrong-token", userId: user.id, newPassword: "Whatever123!" })
        .expect(400);
    });
  });

  describe("Email change", () => {
    it("changes the email after confirming the emailed code", async () => {
      const user = await registerUser(app);
      const newEmail = uniqueEmail("changed");

      await request(app.getHttpServer())
        .post("/auth/request-email-change")
        .set("Authorization", `Bearer ${user.token}`)
        .send({ newEmail })
        .expect(201);

      const code = email.lastCode(newEmail);
      expect(code).toMatch(/^\d{6}$/);

      await request(app.getHttpServer())
        .post("/auth/confirm-email-change")
        .set("Authorization", `Bearer ${user.token}`)
        .send({ code, newEmail })
        .expect(201);

      const me = await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${user.token}`)
        .expect(200);
      expect(me.body.email).toBe(newEmail);
    });
  });
});
