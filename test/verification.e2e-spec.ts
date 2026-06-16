import type { INestApplication } from "@nestjs/common";
import { VerificationCodeTargetType } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import { registerUser } from "./helpers/factory";

describe("Verification", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;
  const DOC = "https://example.com/doc.png";
  const SELFIE = "https://example.com/selfie.png";

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  // Verification codes are hashed and only logged (never emailed/returned), so to
  // confirm one in a test we overwrite the latest code's hash with a known value.
  async function seedCode(
    userId: string,
    targetType: VerificationCodeTargetType,
    code = "123456",
  ): Promise<void> {
    const row = await prisma.verificationCode.findFirst({
      where: { userId, targetType, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw new Error("expected a verification code to seed");
    await prisma.verificationCode.update({
      where: { id: row.id },
      data: { codeHash: await bcrypt.hash(code, 10) },
    });
  }

  it("requests and confirms an email code", async () => {
    const user = await registerUser(app);
    await http()
      .post("/verification/email/request")
      .set("Authorization", auth(user.token))
      .expect(201)
      .expect((res) => expect(res.body.requested).toBe(true));

    await seedCode(user.id, VerificationCodeTargetType.EMAIL);

    const res = await http()
      .post("/verification/email/confirm")
      .set("Authorization", auth(user.token))
      .send({ code: "123456" })
      .expect(201);
    expect(res.body.verificationStatus).toBeDefined();
  });

  it("rejects a wrong email code", async () => {
    const user = await registerUser(app);
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
    const user = await registerUser(app);
    await http()
      .post("/verification/phone/request")
      .set("Authorization", auth(user.token))
      .expect(400);

    await http()
      .patch("/users/me")
      .set("Authorization", auth(user.token))
      .send({ phone: "+5491100000000" })
      .expect(200);

    await http()
      .post("/verification/phone/request")
      .set("Authorization", auth(user.token))
      .expect(201);
    await seedCode(user.id, VerificationCodeTargetType.PHONE);

    await http()
      .post("/verification/phone/confirm")
      .set("Authorization", auth(user.token))
      .send({ code: "123456" })
      .expect(201);
  });

  it("returns the verification status", async () => {
    const user = await registerUser(app);
    await http()
      .get("/verification/me/status")
      .set("Authorization", auth(user.token))
      .expect(200)
      .expect((res) => expect(res.body.verificationStatus).toBeDefined());
  });

  it("submits and lists identity documents", async () => {
    const user = await registerUser(app);
    const submitted = await http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send({ documentUrl: DOC, selfieUrl: SELFIE })
      .expect(201);
    expect(submitted.body.status).toBe("ID_SUBMITTED");

    const list = await http()
      .get("/verification/identity/me")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
  });

  it("requires authentication", async () => {
    await http().post("/verification/email/request").expect(401);
  });
});
