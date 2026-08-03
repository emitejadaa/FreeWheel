import type { INestApplication } from "@nestjs/common";
import { VerificationStatus } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { FakeEmailService } from "./helpers/email.fake";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  registerUser,
  uniqueEmail,
  TEST_PASSWORD,
  TEST_DATE_OF_BIRTH,
} from "./helpers/factory";

describe("Auth", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let email: FakeEmailService;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, prisma, email } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  /** Runs step 1 and returns the emailed code, ready for step 2. */
  async function startRegistration(addr: string): Promise<string> {
    await http().post("/auth/register/start").send({ email: addr }).expect(201);
    const code = email.lastCode(addr);
    if (!code) throw new Error("no registration code captured");
    return code;
  }

  const completeBody = (addr: string, code: string) => ({
    email: addr,
    code,
    password: TEST_PASSWORD,
    firstName: "Ada",
    lastName: "Lovelace",
    acceptedTerms: true,
    dateOfBirth: TEST_DATE_OF_BIRTH,
  });

  describe("Two-step registration", () => {
    it("creates a user only after the email code is confirmed", async () => {
      const addr = uniqueEmail();

      const start = await http()
        .post("/auth/register/start")
        .send({ email: addr })
        .expect(201);
      expect(start.body.expiresAt).toEqual(expect.any(String));
      // No user exists yet.
      expect(
        await prisma.user.findUnique({ where: { email: addr } }),
      ).toBeNull();

      const code = email.lastCode(addr);
      expect(code).toMatch(/^\d{6}$/);

      const res = await http()
        .post("/auth/register/complete")
        .send(completeBody(addr, code!))
        .expect(201);

      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.user.email).toBe(addr);
      expect(res.body.user.password).toBeUndefined();

      const created = await prisma.user.findUnique({ where: { email: addr } });
      expect(created?.verificationStatus).toBe(
        VerificationStatus.EMAIL_VERIFIED,
      );
      expect(created?.emailVerifiedAt).not.toBeNull();
    });

    it("rejects register/start for an already-registered email with 409", async () => {
      const user = await registerUser(app);
      await http()
        .post("/auth/register/start")
        .send({ email: user.email })
        .expect(409);
    });

    it("rejects register/complete with a wrong code (400)", async () => {
      const addr = uniqueEmail();
      await startRegistration(addr);
      await http()
        .post("/auth/register/complete")
        .send({ ...completeBody(addr, "000000") })
        .expect(400);
      expect(
        await prisma.user.findUnique({ where: { email: addr } }),
      ).toBeNull();
    });

    it("rejects register/complete for an under-18 date of birth (400)", async () => {
      const addr = uniqueEmail();
      const code = await startRegistration(addr);
      const under18 = new Date();
      under18.setFullYear(under18.getFullYear() - 15);
      await http()
        .post("/auth/register/complete")
        .send({
          ...completeBody(addr, code),
          dateOfBirth: under18.toISOString().slice(0, 10),
        })
        .expect(400);
    });

    it("rejects invalid register/complete payloads (400)", async () => {
      const addr = uniqueEmail();
      const code = await startRegistration(addr);
      // short password
      await http()
        .post("/auth/register/complete")
        .send({ ...completeBody(addr, code), password: "123" })
        .expect(400);
      // terms not accepted
      await http()
        .post("/auth/register/complete")
        .send({ ...completeBody(addr, code), acceptedTerms: false })
        .expect(400);
      // unknown field rejected by forbidNonWhitelisted
      await http()
        .post("/auth/register/complete")
        .send({ ...completeBody(addr, code), role: "ADMIN" })
        .expect(400);
    });
  });

  describe("POST /auth/login", () => {
    it("logs in a verified user and returns a token", async () => {
      const user = await registerUser(app);
      const res = await http()
        .post("/auth/login")
        .send({ email: user.email, password: user.password })
        .expect(201);
      expect(res.body.accessToken).toEqual(expect.any(String));
    });

    it("rejects a wrong password and an unknown email with 401", async () => {
      const user = await registerUser(app);
      await http()
        .post("/auth/login")
        .send({ email: user.email, password: "WrongPass123!" })
        .expect(401);
      await http()
        .post("/auth/login")
        .send({ email: uniqueEmail(), password: TEST_PASSWORD })
        .expect(401);
    });

    it("blocks a legacy unverified-email account and returns an onboarding token", async () => {
      const addr = uniqueEmail("legacy");
      await prisma.user.create({
        data: {
          email: addr,
          password: await bcrypt.hash(TEST_PASSWORD, 10),
          firstName: "Old",
          lastName: "User",
          verificationStatus: VerificationStatus.UNVERIFIED,
        },
      });

      const res = await http()
        .post("/auth/login")
        .send({ email: addr, password: TEST_PASSWORD })
        .expect(201);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.emailVerificationRequired).toBe(true);
      expect(res.body.onboardingToken).toEqual(expect.any(String));
      // A fresh code was emailed so the user can finish verifying.
      expect(email.lastCode(addr)).toMatch(/^\d{6}$/);
    });

    it("blocks an account missing its date of birth and returns an onboarding token", async () => {
      const addr = uniqueEmail("nodob");
      await prisma.user.create({
        data: {
          email: addr,
          password: await bcrypt.hash(TEST_PASSWORD, 10),
          firstName: "No",
          lastName: "Dob",
          verificationStatus: VerificationStatus.EMAIL_VERIFIED,
          emailVerifiedAt: new Date(),
        },
      });

      const res = await http()
        .post("/auth/login")
        .send({ email: addr, password: TEST_PASSWORD })
        .expect(201);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.profileCompletionRequired).toBe(true);
      expect(res.body.onboardingToken).toEqual(expect.any(String));
    });
  });

  describe("Onboarding token scope", () => {
    it("is rejected on normal endpoints but accepted by complete-profile", async () => {
      const addr = uniqueEmail("nodob");
      await prisma.user.create({
        data: {
          email: addr,
          password: await bcrypt.hash(TEST_PASSWORD, 10),
          firstName: "No",
          lastName: "Dob",
          verificationStatus: VerificationStatus.EMAIL_VERIFIED,
          emailVerifiedAt: new Date(),
        },
      });
      const login = await http()
        .post("/auth/login")
        .send({ email: addr, password: TEST_PASSWORD })
        .expect(201);
      const onboardingToken: string = login.body.onboardingToken;

      // Scoped token must NOT work on a normal protected endpoint.
      await http()
        .get("/users/me")
        .set("Authorization", `Bearer ${onboardingToken}`)
        .expect(401);

      // Under-18 still rejected here.
      await http()
        .post("/auth/complete-profile")
        .set("Authorization", `Bearer ${onboardingToken}`)
        .send({ dateOfBirth: "2015-01-01" })
        .expect(400);

      // Completing the profile returns a full token that DOES work.
      const completed = await http()
        .post("/auth/complete-profile")
        .set("Authorization", `Bearer ${onboardingToken}`)
        .send({ dateOfBirth: TEST_DATE_OF_BIRTH })
        .expect(201);
      expect(completed.body.accessToken).toEqual(expect.any(String));

      await http()
        .get("/users/me")
        .set("Authorization", `Bearer ${completed.body.accessToken}`)
        .expect(200);
    });
  });

  describe("Legacy email verification", () => {
    it("verifies with the emailed code and returns a full token", async () => {
      const addr = uniqueEmail("legacy");
      await prisma.user.create({
        data: {
          email: addr,
          password: await bcrypt.hash(TEST_PASSWORD, 10),
          firstName: "Old",
          lastName: "User",
          verificationStatus: VerificationStatus.UNVERIFIED,
          dateOfBirth: new Date(`${TEST_DATE_OF_BIRTH}T00:00:00.000Z`),
        },
      });
      const login = await http()
        .post("/auth/login")
        .send({ email: addr, password: TEST_PASSWORD })
        .expect(201);
      const code = email.lastCode(addr);

      const res = await http()
        .post("/auth/verify-email")
        .set("Authorization", `Bearer ${login.body.onboardingToken}`)
        .send({ code })
        .expect(201);
      expect(res.body.accessToken).toEqual(expect.any(String));
    });

    it("requires authentication", async () => {
      await http()
        .post("/auth/verify-email")
        .send({ code: "123456" })
        .expect(401);
    });
  });

  describe("Password reset", () => {
    it("is enumeration-safe (same reply for known and unknown emails)", async () => {
      const user = await registerUser(app);
      const known = await http()
        .post("/auth/forgot-password")
        .send({ email: user.email })
        .expect(201);
      const unknown = await http()
        .post("/auth/forgot-password")
        .send({ email: uniqueEmail() })
        .expect(201);
      expect(known.body.message).toBe(unknown.body.message);
    });

    it("resets the password with the emailed token, then login uses the new password", async () => {
      const user = await registerUser(app);
      await http()
        .post("/auth/forgot-password")
        .send({ email: user.email })
        .expect(201);
      const token = email.lastResetToken(user.email);
      expect(token).toEqual(expect.any(String));

      const newPassword = "BrandNewPass456!";
      await http()
        .post("/auth/reset-password")
        .send({ token, userId: user.id, newPassword })
        .expect(201);

      await http()
        .post("/auth/login")
        .send({ email: user.email, password: newPassword })
        .expect(201);
      await http()
        .post("/auth/login")
        .send({ email: user.email, password: user.password })
        .expect(401);
    });

    it("rejects an invalid reset token with 400", async () => {
      const user = await registerUser(app);
      await http()
        .post("/auth/forgot-password")
        .send({ email: user.email })
        .expect(201);
      await http()
        .post("/auth/reset-password")
        .send({
          token: "wrong-token",
          userId: user.id,
          newPassword: "Whatever123!",
        })
        .expect(400);
    });
  });

  describe("Email change", () => {
    it("changes the email after confirming the emailed code", async () => {
      const user = await registerUser(app);
      const newEmail = uniqueEmail("changed");

      await http()
        .post("/auth/request-email-change")
        .set("Authorization", `Bearer ${user.token}`)
        .send({ newEmail })
        .expect(201);

      const code = email.lastCode(newEmail);
      expect(code).toMatch(/^\d{6}$/);

      await http()
        .post("/auth/confirm-email-change")
        .set("Authorization", `Bearer ${user.token}`)
        .send({ code, newEmail })
        .expect(201);

      const me = await http()
        .get("/users/me")
        .set("Authorization", `Bearer ${user.token}`)
        .expect(200);
      expect(me.body.email).toBe(newEmail);
    });
  });
});
