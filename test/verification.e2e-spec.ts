import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { FakeEmailService } from "./helpers/email.fake";
import { FakeSmsService } from "./helpers/sms.fake";
import { PrismaService } from "../src/prisma/prisma.service";
import { registerUser } from "./helpers/factory";

describe("Verification", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let email: FakeEmailService;
  let sms: FakeSmsService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;
  const PHONE = "+5491100000001";
  const DOCS = {
    dniFrontUrl: "https://example.com/dni-front.png",
    dniBackUrl: "https://example.com/dni-back.png",
    licenseFrontUrl: "https://example.com/license-front.png",
    licenseBackUrl: "https://example.com/license-back.png",
  };

  beforeAll(async () => {
    ({ app, prisma, email, sms } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  /** Sets a phone, requests a phone code, and confirms it using the SMS fake. */
  async function verifyPhone(token: string, phone = PHONE): Promise<void> {
    await http()
      .patch("/users/me")
      .set("Authorization", auth(token))
      .send({ phone })
      .expect(200);
    await http()
      .post("/verification/phone/request")
      .set("Authorization", auth(token))
      .expect(201);
    const code = sms.lastCode(phone);
    if (!code) throw new Error("no SMS code captured");
    await http()
      .post("/verification/phone/confirm")
      .set("Authorization", auth(token))
      .send({ code })
      .expect(201);
  }

  it("requests and confirms an email code (delivered via the email fake)", async () => {
    const user = await registerUser(app, { verified: false });
    await http()
      .post("/verification/email/request")
      .set("Authorization", auth(user.token))
      .expect(201)
      .expect((res) => expect(res.body.requested).toBe(true));

    const code = email.lastCode(user.email);
    expect(code).toMatch(/^\d{6}$/);

    const res = await http()
      .post("/verification/email/confirm")
      .set("Authorization", auth(user.token))
      .send({ code })
      .expect(201);
    expect(res.body.verificationStatus).toBeDefined();
  });

  it("rejects a wrong email code", async () => {
    const user = await registerUser(app, { verified: false });
    await http()
      .post("/verification/email/request")
      .set("Authorization", auth(user.token))
      .expect(201);
    await http()
      .post("/verification/email/confirm")
      .set("Authorization", auth(user.token))
      .send({ code: "000000" })
      .expect(400);
  });

  it("requires a phone before requesting a phone code, then confirms it", async () => {
    const user = await registerUser(app, { verified: false });
    await http()
      .post("/verification/phone/request")
      .set("Authorization", auth(user.token))
      .expect(400);

    await verifyPhone(user.token);
  });

  it("returns the verification status with a derived checklist", async () => {
    const user = await registerUser(app, { verified: false });
    const res = await http()
      .get("/verification/me/status")
      .set("Authorization", auth(user.token))
      .expect(200);

    expect(res.body.verificationStatus).toBeDefined();
    expect(res.body.fullyVerified).toBe(false);
    expect(res.body.checklist).toEqual({
      emailVerified: true,
      phoneVerified: false,
      documentsSubmitted: false,
      dateOfBirthProvided: true,
    });
  });

  it("submits and lists identity documents", async () => {
    const user = await registerUser(app, { verified: false });
    const submitted = await http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send(DOCS)
      .expect(201);
    expect(submitted.body.dniFrontUrl).toBe(DOCS.dniFrontUrl);

    const list = await http()
      .get("/verification/identity/me")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects an identity submission missing a required document (400)", async () => {
    const user = await registerUser(app, { verified: false });
    const { licenseBackUrl: _omitted, ...incomplete } = DOCS;
    await http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send(incomplete)
      .expect(400);
  });

  it("auto-verifies the account once phone is confirmed and documents submitted", async () => {
    const user = await registerUser(app, { verified: false });

    await verifyPhone(user.token);
    await http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send(DOCS)
      .expect(201);

    const status = await http()
      .get("/verification/me/status")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(status.body.fullyVerified).toBe(true);
    expect(status.body.verificationStatus).toBe("VERIFIED");
    expect(status.body.checklist).toEqual({
      emailVerified: true,
      phoneVerified: true,
      documentsSubmitted: true,
      dateOfBirthProvided: true,
    });
  });

  it("requires authentication", async () => {
    await http().post("/verification/email/request").expect(401);
  });
});
