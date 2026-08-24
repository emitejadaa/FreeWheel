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
  documentUrls,
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
      dniApproved: false,
      licenseApproved: false,
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

  it("submits a document and lists it without echoing its URLs", async () => {
    const user = await registerUser(app, { verified: false });
    await setIdentityProfile(app, user.token);

    const submitted = await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "dni"))
      .expect(201);

    expect(submitted.body.type).toBe("DNI");
    expect(submitted.body.documents).toEqual({ front: true, back: true });
    // Los documentos son PII: la respuesta nunca devuelve las URLs.
    expect(JSON.stringify(submitted.body)).not.toContain("cloudinary");

    const mine = await http()
      .get("/verification/identity/me")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(mine.body.dni).not.toBeNull();
    expect(mine.body.license).toBeNull();
    expect(JSON.stringify(mine.body)).not.toContain("cloudinary");
  });

  it("rejects an unknown document type in the URL (400)", async () => {
    const user = await registerUser(app, { verified: false });
    await setIdentityProfile(app, user.token);
    await http()
      .post("/verification/identity/pasaporte/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "dni"))
      .expect(400);
  });

  it("rejects a submission missing one of the two photos (400)", async () => {
    const user = await registerUser(app, { verified: false });
    await setIdentityProfile(app, user.token);
    const { frontUrl } = documentUrls(user.id, "dni");
    await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send({ frontUrl })
      .expect(400);
  });

  it("rejects a document URL that is not one we signed (400)", async () => {
    const user = await registerUser(app, { verified: false });
    await setIdentityProfile(app, user.token);
    const res = await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send({
        ...documentUrls(user.id, "dni"),
        frontUrl: "https://example.com/dni-front.png",
      })
      .expect(400);
    expect(res.body.code).toBe("INVALID_DOCUMENT_URL");
  });

  it("rejects a file uploaded for a different slot (400 DOCUMENT_SLOT_MISMATCH)", async () => {
    const user = await registerUser(app, { verified: false });
    await setIdentityProfile(app, user.token);
    const res = await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send({
        ...documentUrls(user.id, "dni"),
        // El dorso de la licencia enviado como frente del DNI.
        frontUrl: identityDocUrl(user.id, "license_back"),
      })
      .expect(400);
    expect(res.body.code).toBe("DOCUMENT_SLOT_MISMATCH");
    expect(res.body.slot).toBe("dni_front");
  });

  it("rejects documents belonging to another account (400)", async () => {
    const user = await registerUser(app, { verified: false });
    const other = await registerUser(app, { verified: false });
    await setIdentityProfile(app, user.token);
    const res = await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send({
        ...documentUrls(user.id, "dni"),
        backUrl: identityDocUrl(other.id, "dni_back"),
      })
      .expect(400);
    expect(res.body.code).toBe("DOCUMENT_SLOT_MISMATCH");
  });

  it("rejects a URL whose file was never uploaded (400 DOCUMENT_NOT_FOUND)", async () => {
    const user = await registerUser(app, { verified: false });
    await setIdentityProfile(app, user.token);
    cloudinary.missing.add(`identity/${user.id}/dni_front_1700000000_abcdef01`);
    const res = await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "dni"))
      .expect(400);
    expect(res.body.code).toBe("DOCUMENT_NOT_FOUND");
    expect(res.body.slot).toBe("dni_front");
  });

  it("refuses to start the flow with an incomplete profile (400 PERFIL_INCOMPLETO)", async () => {
    const user = await registerUser(app, { verified: false });
    const res = await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "dni"))
      .expect(400);
    expect(res.body.code).toBe("PERFIL_INCOMPLETO");
    expect(res.body.missing).toEqual(
      expect.arrayContaining(["DNI", "CUIL", "domicilio"]),
    );
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

  it("verifies the account only once BOTH documents are approved", async () => {
    const user = await registerUser(app, { verified: false });
    await verifyPhone(user.token);
    await setIdentityProfile(app, user.token);

    // Solo el DNI: la cuenta todavía no está verificada.
    await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "dni"))
      .expect(201);

    const parcial = await http()
      .get("/verification/me/status")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(parcial.body.fullyVerified).toBe(false);
    expect(parcial.body.verificationStatus).toBe("ID_SUBMITTED");
    expect(parcial.body.checklist.dniApproved).toBe(true);
    expect(parcial.body.checklist.licenseApproved).toBe(false);

    // Con la licencia también aprobada, la cuenta queda VERIFIED.
    await http()
      .post("/verification/identity/license/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "license"))
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
      dateOfBirthProvided: true,
      identityDataProvided: true,
      dniApproved: true,
      licenseApproved: true,
    });
  });

  it("refuses to resubmit a document that is already approved (400)", async () => {
    const user = await registerUser(app, { verified: false });
    await setIdentityProfile(app, user.token);
    await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "dni"))
      .expect(201);

    const res = await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "dni"))
      .expect(400);
    expect(res.body.code).toBe("DOCUMENT_ALREADY_APPROVED");
  });

  it("requires authentication", async () => {
    await http().post("/verification/email/request").expect(401);
  });
});
