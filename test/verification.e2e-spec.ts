import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { FakeEmailService } from "./helpers/email.fake";
import { FakeSmsService } from "./helpers/sms.fake";
import { PrismaService } from "../src/prisma/prisma.service";
import { registerUser, setIdentityProfile } from "./helpers/factory";
import {
  FakeCloudinaryService,
  identityDocs,
  identityDocUrl,
} from "./helpers/cloudinary.fake";

describe("Verification", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let email: FakeEmailService;
  let sms: FakeSmsService;
  let cloudinary: FakeCloudinaryService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;
  const PHONE = "+5491100000001";

  beforeAll(async () => {
    ({ app, prisma, email, sms, cloudinary } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
    cloudinary.reset();
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
      identityDataProvided: false,
    });
  });

  it("signs one upload per document side, forcing folder and public_id", async () => {
    const user = await registerUser(app, { verified: false });
    const res = await http()
      .post("/verification/identity/upload-signature")
      .set("Authorization", auth(user.token))
      .send({ document: "license", side: "back" })
      .expect(201);

    expect(res.body.folder).toBe(`identity/${user.id}`);
    expect(res.body.publicId).toMatch(
      new RegExp(`^identity/${user.id}/license_back_\\d+_[0-9a-f]{8}$`),
    );
    expect(res.body.type).toBe("authenticated");
    expect(res.body.signature).toBeDefined();
  });

  it("rejects an upload signature for an unknown document or side (400)", async () => {
    const user = await registerUser(app, { verified: false });
    await http()
      .post("/verification/identity/upload-signature")
      .set("Authorization", auth(user.token))
      .send({ document: "pasaporte", side: "front" })
      .expect(400);
    await http()
      .post("/verification/identity/upload-signature")
      .set("Authorization", auth(user.token))
      .send({ document: "dni" })
      .expect(400);
  });

  it("submits and lists identity documents without echoing their URLs", async () => {
    const user = await registerUser(app, { verified: false });
    const submitted = await http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send(identityDocs(user.id))
      .expect(201);

    expect(submitted.body.documents).toEqual({
      dniFront: true,
      dniBack: true,
      licenseFront: true,
      licenseBack: true,
    });
    // Los documentos son PII: la respuesta nunca devuelve las URLs.
    expect(JSON.stringify(submitted.body)).not.toContain("cloudinary");

    const list = await http()
      .get("/verification/identity/me")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(list.body)).not.toContain("cloudinary");
  });

  it("rejects an identity submission missing a required document (400)", async () => {
    const user = await registerUser(app, { verified: false });
    const { licenseBackUrl: _omitted, ...incomplete } = identityDocs(user.id);
    await http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send(incomplete)
      .expect(400);
  });

  it("rejects a document URL that is not one we signed (400)", async () => {
    const user = await registerUser(app, { verified: false });
    const res = await http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send({
        ...identityDocs(user.id),
        dniFrontUrl: "https://example.com/dni-front.png",
      })
      .expect(400);
    expect(res.body.code).toBe("INVALID_DOCUMENT_URL");
  });

  it("rejects a file uploaded for a different slot (400 DOCUMENT_SLOT_MISMATCH)", async () => {
    const user = await registerUser(app, { verified: false });
    const res = await http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send({
        ...identityDocs(user.id),
        // El dorso de la licencia enviado como frente del DNI.
        dniFrontUrl: identityDocUrl(user.id, "license_back"),
      })
      .expect(400);
    expect(res.body.code).toBe("DOCUMENT_SLOT_MISMATCH");
    expect(res.body.slot).toBe("dni_front");
  });

  it("rejects documents belonging to another account (400)", async () => {
    const user = await registerUser(app, { verified: false });
    const other = await registerUser(app, { verified: false });
    const res = await http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send({
        ...identityDocs(user.id),
        dniBackUrl: identityDocUrl(other.id, "dni_back"),
      })
      .expect(400);
    expect(res.body.code).toBe("DOCUMENT_SLOT_MISMATCH");
  });

  it("rejects a URL whose file was never uploaded (400 DOCUMENT_NOT_FOUND)", async () => {
    const user = await registerUser(app, { verified: false });
    cloudinary.missing.add(`identity/${user.id}/dni_front_1700000000_abcdef01`);
    const res = await http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send(identityDocs(user.id))
      .expect(400);
    expect(res.body.code).toBe("DOCUMENT_NOT_FOUND");
    expect(res.body.slot).toBe("dni_front");
  });

  it("keeps the identity/ folder off the generic media signature endpoint", async () => {
    const user = await registerUser(app, { verified: false });
    const res = await http()
      .post("/media/cloudinary-signature")
      .set("Authorization", auth(user.token))
      .send({ folder: `identity/${user.id}` })
      .expect(400);
    expect(res.body.code).toBe("RESERVED_MEDIA_FOLDER");
  });

  it("auto-verifies once phone, identity data and documents are complete", async () => {
    const user = await registerUser(app, { verified: false });

    await verifyPhone(user.token);
    await setIdentityProfile(app, user.token);
    await http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send(identityDocs(user.id))
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
      identityDataProvided: true,
    });
  });

  it("does not auto-verify while dni/cuil/address are missing, then unlocks via PATCH /users/me", async () => {
    const user = await registerUser(app, { verified: false });

    await verifyPhone(user.token);
    await http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send(identityDocs(user.id))
      .expect(201);

    const pending = await http()
      .get("/verification/me/status")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(pending.body.fullyVerified).toBe(false);
    expect(pending.body.verificationStatus).toBe("ID_SUBMITTED");
    expect(pending.body.checklist.identityDataProvided).toBe(false);

    // Completing the manual identity data is the last checklist item: the
    // profile update itself re-runs the review and verifies the account.
    await setIdentityProfile(app, user.token);

    const status = await http()
      .get("/verification/me/status")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(status.body.fullyVerified).toBe(true);
    expect(status.body.verificationStatus).toBe("VERIFIED");
  });

  it("requires authentication", async () => {
    await http().post("/verification/email/request").expect(401);
  });

});
