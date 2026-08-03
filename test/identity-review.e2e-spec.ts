import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import { FakeSmsService } from "./helpers/sms.fake";
import { FakeCloudinaryService, identityDocs } from "./helpers/cloudinary.fake";
import {
  FakeIdentityExtraction,
  IdentityPersona,
  personaFor,
} from "./helpers/identity.fake";
import {
  AuthedUser,
  cuilFor,
  createAdmin,
  registerUser,
  uniqueDni,
} from "./helpers/factory";

/**
 * Revisión documental real (IDENTITY_REVIEW_MODE=document_ai): el lector de
 * códigos y el OCR están fakeados, todo lo demás —parsers, cruces, política
 * de veredicto y persistencia— corre de verdad.
 */
describe("Identity review (document_ai)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sms: FakeSmsService;
  let cloudinary: FakeCloudinaryService;
  let identity: FakeIdentityExtraction;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    ({ app, prisma, sms, cloudinary, identity } = await createTestApp({
      identityReviewMode: "document_ai",
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
    cloudinary.reset();
    identity.reset();
  });

  /**
   * Cuenta lista para verificar: email y teléfono confirmados, datos de
   * identidad cargados a mano y documentos que muestran a esa misma persona.
   */
  async function readyUser(
    overrides: {
      profile?: Partial<{ dni: string; cuil: string; address: string }>;
      persona?: Partial<IdentityPersona>;
      firstName?: string;
      lastName?: string;
      dateOfBirth?: string;
    } = {},
  ): Promise<{ user: AuthedUser; persona: IdentityPersona }> {
    const user = await registerUser(app, {
      verified: false,
      firstName: overrides.firstName ?? "Juan Carlos",
      lastName: overrides.lastName ?? "Perez",
      dateOfBirth: overrides.dateOfBirth ?? "1990-02-01",
    });

    const phone = `+54911${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    await http()
      .patch("/users/me")
      .set("Authorization", auth(user.token))
      .send({ phone })
      .expect(200);
    await http()
      .post("/verification/phone/request")
      .set("Authorization", auth(user.token))
      .expect(201);
    await http()
      .post("/verification/phone/confirm")
      .set("Authorization", auth(user.token))
      .send({ code: sms.lastCode(phone) })
      .expect(201);

    const dni = overrides.profile?.dni ?? uniqueDni();
    const profile = {
      dni,
      cuil: overrides.profile?.cuil ?? cuilFor(dni),
      address:
        overrides.profile?.address ?? "Av. Siempre Viva 742, Springfield, CABA",
    };
    await http()
      .patch("/users/me")
      .set("Authorization", auth(user.token))
      .send(profile)
      .expect(200);

    const persona = identity.register(
      user.id,
      personaFor({
        dni: profile.dni,
        cuil: profile.cuil,
        address: profile.address,
        ...overrides.persona,
      }),
    );

    return { user, persona };
  }

  function submit(user: AuthedUser) {
    return http()
      .post("/verification/identity/submit")
      .set("Authorization", auth(user.token))
      .send(identityDocs(user.id));
  }

  function status(user: AuthedUser) {
    return http()
      .get("/verification/me/status")
      .set("Authorization", auth(user.token));
  }

  it("verifica la cuenta cuando documentos, códigos y datos coinciden", async () => {
    const { user } = await readyUser();

    const submitted = await submit(user).expect(201);
    expect(submitted.body.status).toBe("VERIFIED");
    expect(submitted.body.reasonCodes).toEqual([]);

    const res = await status(user).expect(200);
    expect(res.body.fullyVerified).toBe(true);
    expect(res.body.lastReview.outcome).toBe("approved");

    // Se guardan los datos de la revisión para auditoría y antifraude.
    const stored = await prisma.userVerification.findFirst({
      where: { userId: user.id },
    });
    expect(stored?.reviewerName).toBe("document_ai");
    expect(stored?.dniNumber).toBeTruthy();
    expect(stored?.licenseExpiresAt).toBeInstanceOf(Date);
    expect(stored?.matchReport).toBeTruthy();

    const audit = await prisma.auditLog.findFirst({
      where: { targetUserId: user.id, action: "identity.review.auto" },
    });
    expect(audit).toBeTruthy();
    // Minimización de datos: la auditoría no guarda lo extraído del documento.
    expect(JSON.stringify(audit?.metadata)).not.toContain(stored?.dniNumber);
  });

  it("rechaza cuando la fecha de nacimiento declarada no es la del documento", async () => {
    const { user } = await readyUser({
      dateOfBirth: "1995-05-05",
      persona: { birthDate: "1990-02-01" },
    });

    const submitted = await submit(user).expect(201);
    expect(submitted.body.status).toBe("REJECTED");
    expect(submitted.body.reasonCodes).toContain("DOB_MISMATCH");

    const res = await status(user).expect(200);
    expect(res.body.fullyVerified).toBe(false);
    expect(res.body.verificationStatus).toBe("REJECTED");
    expect(res.body.lastReview.outcome).toBe("rejected");
  });

  it("rechaza cuando el apellido de la cuenta no es el del documento", async () => {
    const { user } = await readyUser({ lastName: "Gomez" });
    const submitted = await submit(user).expect(201);
    expect(submitted.body.status).toBe("REJECTED");
    expect(submitted.body.reasonCodes).toContain("SURNAME_MISMATCH");
  });

  it("rechaza una licencia vencida", async () => {
    const { user } = await readyUser({
      persona: { licenseExpiry: "2020-01-01" },
    });
    const submitted = await submit(user).expect(201);
    expect(submitted.body.status).toBe("REJECTED");
    expect(submitted.body.reasonCodes).toContain("LICENSE_EXPIRED");
  });

  it("rechaza si el titular es menor de 18 según el documento", async () => {
    // El registro exige declarar 18+, así que el caso real es un documento de
    // una persona menor con una fecha de nacimiento falseada en la cuenta.
    const { user } = await readyUser({ persona: { birthDate: "2012-01-01" } });
    const submitted = await submit(user).expect(201);
    expect(submitted.body.status).toBe("REJECTED");
    expect(submitted.body.reasonCodes).toContain("UNDERAGE");
  });

  it("deja el caso pendiente para el admin si no se puede leer el código ni el MRZ", async () => {
    const { user, persona } = await readyUser();
    identity.breakBarcode("dni_front");
    identity.setOcr("dni_back", {
      classifiedAs: "dni_back",
      // Sin mrzLines: no queda ninguna fuente autoritativa.
      fields: { domicilio: persona.address, cuil: persona.cuil },
    });

    const submitted = await submit(user).expect(201);
    expect(submitted.body.status).toBe("ID_SUBMITTED");
    expect(submitted.body.reasonCodes).toContain("NO_AUTHORITATIVE_SOURCE");

    const res = await status(user).expect(200);
    expect(res.body.fullyVerified).toBe(false);
    expect(res.body.lastReview.outcome).toBe("pending");
  });

  it("usa el MRZ como respaldo cuando el PDF417 no se puede decodificar", async () => {
    const { user } = await readyUser();
    identity.breakBarcode("dni_front");

    const submitted = await submit(user).expect(201);
    expect(submitted.body.status).toBe("VERIFIED");
  });

  it("permite al admin aprobar un caso que quedó pendiente", async () => {
    const admin = await createAdmin(app, prisma);
    const { user, persona } = await readyUser();
    identity.breakBarcode("dni_front");
    identity.setOcr("dni_back", {
      classifiedAs: "dni_back",
      fields: { domicilio: persona.address, cuil: persona.cuil },
    });
    await submit(user).expect(201);

    const pending = await prisma.userVerification.findFirstOrThrow({
      where: { userId: user.id },
    });
    await http()
      .patch(`/admin/verifications/${pending.id}/review`)
      .set("Authorization", auth(admin.token))
      .send({ status: "VERIFIED", notes: "Documentos revisados a mano" })
      .expect(200);

    const res = await status(user).expect(200);
    expect(res.body.fullyVerified).toBe(true);
  });

  it("reintenta la revisión tras corregir la lectura y verifica la cuenta", async () => {
    const { user, persona } = await readyUser();
    identity.breakBarcode("dni_front");
    identity.setOcr("dni_back", {
      classifiedAs: "dni_back",
      fields: { domicilio: persona.address, cuil: persona.cuil },
    });
    await submit(user).expect(201);

    // Ahora el código sí se lee (p. ej. el proveedor se recuperó).
    identity.reset();
    identity.register(user.id, persona);

    const retried = await http()
      .post("/verification/identity/review-retry")
      .set("Authorization", auth(user.token))
      .expect(201);
    expect(retried.body.fullyVerified).toBe(true);
  });

  it("rechaza el reintento cuando ya hay un veredicto (400)", async () => {
    const { user } = await readyUser();
    const submitted = await submit(user).expect(201);
    expect(submitted.body.status).toBe("VERIFIED");

    const res = await http()
      .post("/verification/identity/review-retry")
      .set("Authorization", auth(user.token))
      .expect(400);
    expect(res.body.code).toBe("REVIEW_NOT_PENDING");
  });

  it("no verifica dos cuentas con el mismo documento", async () => {
    const first = await readyUser();
    await submit(first.user).expect(201);
    expect((await status(first.user)).body.fullyVerified).toBe(true);

    // Otra cuenta sube documentos de la MISMA persona (documento robado).
    const second = await registerUser(app, {
      verified: false,
      firstName: "Juan Carlos",
      lastName: "Perez",
      dateOfBirth: "1990-02-01",
    });
    const phone = "+5491155559999";
    await http()
      .patch("/users/me")
      .set("Authorization", auth(second.token))
      .send({ phone })
      .expect(200);
    await http()
      .post("/verification/phone/request")
      .set("Authorization", auth(second.token))
      .expect(201);
    await http()
      .post("/verification/phone/confirm")
      .set("Authorization", auth(second.token))
      .send({ code: sms.lastCode(phone) })
      .expect(201);

    // El DNI ya está tomado a nivel de cuenta: no puede ni cargarlo.
    const clash = await http()
      .patch("/users/me")
      .set("Authorization", auth(second.token))
      .send({ dni: first.persona.dni })
      .expect(409);
    expect(clash.body.code).toBe("DNI_ALREADY_REGISTERED");
  });

  it("el admin ve los documentos con URLs firmadas y queda auditado", async () => {
    const admin = await createAdmin(app, prisma);
    const { user } = await readyUser();
    await submit(user).expect(201);
    const submission = await prisma.userVerification.findFirstOrThrow({
      where: { userId: user.id },
    });

    const res = await http()
      .get(`/admin/verifications/${submission.id}/documents`)
      .set("Authorization", auth(admin.token))
      .expect(200);

    expect(res.body.documents.dniFront).toContain("/image/authenticated/");
    expect(res.body.documents.licenseBack).toContain("s--");
    expect(res.body.matchReport).toBeTruthy();

    const audit = await prisma.auditLog.findFirst({
      where: { action: "admin.verification.documents.view" },
    });
    expect(audit?.actorId).toBe(admin.id);
  });

  it("un usuario común no puede ver los documentos de una solicitud", async () => {
    const { user } = await readyUser();
    await submit(user).expect(201);
    const submission = await prisma.userVerification.findFirstOrThrow({
      where: { userId: user.id },
    });

    await http()
      .get(`/admin/verifications/${submission.id}/documents`)
      .set("Authorization", auth(user.token))
      .expect(403);
  });

  it("nunca expone al usuario las URLs ni los datos extraídos", async () => {
    const { user } = await readyUser();
    await submit(user).expect(201);

    const list = await http()
      .get("/verification/identity/me")
      .set("Authorization", auth(user.token))
      .expect(200);

    const serialized = JSON.stringify(list.body);
    expect(serialized).not.toContain("cloudinary");
    expect(serialized).not.toContain("PEREZ");
    expect(serialized).not.toContain("matchReport");
  });
});
