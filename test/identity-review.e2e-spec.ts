import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  createAdmin,
  cuilFor,
  registerUser,
  setIdentityProfile,
  uniqueDni,
} from "./helpers/factory";
import {
  documentUrls,
  FakeCloudinaryService,
} from "./helpers/cloudinary.fake";

/**
 * LA VERIFICACIÓN DOCUMENTAL DE PUNTA A PUNTA — REVISIÓN MANUAL
 *
 * Este backend no lee las fotos: las valida como archivos (que sean nuestras,
 * del slot correcto y de esta cuenta), las guarda y las deja para un admin. La
 * lectura automática corre en un servicio aparte (docverify-api/) que no está
 * conectado con este, así que lo que se ejercita acá es el circuito completo
 * de la revisión: enviar → pedir revisión → veredicto del admin, más las dos
 * salidas que conserva el usuario (reenviar fotos o volver a la cola).
 */
describe("Verificación documental (revisión manual)", () => {
  // Esta suite corre SIN DOCVERIFY_URL, o sea sin lectura automática, que es
  // el modo en que un deploy funciona cuando el servicio de lectura no está
  // configurado o se cayó. Lo que se ejercita acá es que todo el circuito
  // manual siga funcionando igual en ese caso: la lectura automática acelera
  // la verificación, no es un requisito para verificarse.
  let app: INestApplication;
  let prisma: PrismaService;
  let cloudinary: FakeCloudinaryService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    ({ app, prisma, cloudinary } = await createTestApp({
      withStorageEnv: true,
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
    cloudinary.reset();
  });

  /** Una cuenta con el perfil de identidad completo: lo que exige el submit. */
  async function cuentaCompleta(): Promise<{
    token: string;
    id: string;
    dni: string;
  }> {
    const user = await registerUser(app, { verified: false });
    const dni = uniqueDni();
    await setIdentityProfile(app, user.token, { dni, cuil: cuilFor(dni) });
    return { token: user.token, id: user.id, dni };
  }

  const submit = (token: string, userId: string, kind: "dni" | "license") =>
    http()
      .post(`/verification/identity/${kind}/submit`)
      .set("Authorization", auth(token))
      .send(documentUrls(userId, kind));

  const pedirRevision = (token: string, kind: "dni" | "license") =>
    http()
      .post(`/verification/identity/${kind}/request-review`)
      .set("Authorization", auth(token));

  // ── El envío ───────────────────────────────────────────────────────────

  it("sin lectura automática, enviar las fotos deja el documento PENDING y avisa por qué", async () => {
    const { token, id, dni } = await cuentaCompleta();

    const res = await submit(token, id, "dni").expect(201);

    expect(res.body.status).toBe("PENDING");
    expect(res.body.documents).toEqual({ front: true, back: true });
    // Las dos salidas quedan abiertas: reenviar fotos o pedir la revisión.
    expect(res.body.canResubmit).toBe(true);
    expect(res.body.canRequestManualReview).toBe(true);

    // `reasons` es "qué está mal con TU documento", y acá no hay nada mal:
    // el que no está es nuestro servicio de lectura. Ese aviso va por
    // `analysis`, separado, para que el front no le muestre a la persona un
    // problema en su documentación que no existe.
    expect(res.body.reasons).toEqual([]);
    expect(res.body.analysis.status).toBe("FAILED");
    expect(res.body.analysis.pending).toBe(false);
    expect(res.body.analysis.error).toContain("administrador");

    const row = await prisma.documentVerification.findFirstOrThrow({
      where: { userId: id },
    });
    expect(row.status).toBe("PENDING");
    expect(row.documentNumber).toBe(dni);
    expect(row.reviewRequestedAt).toBeNull();
    expect(row.reasonCodes).toEqual([]);

    // La cuenta registra que hay documentación cargada.
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.verificationStatus).toBe("ID_SUBMITTED");
  });

  it("DNI y licencia son dos flujos separados", async () => {
    const { token, id } = await cuentaCompleta();

    await submit(token, id, "dni").expect(201);
    const mine = await http()
      .get("/verification/identity/me")
      .set("Authorization", auth(token))
      .expect(200);
    expect(mine.body.dni.status).toBe("PENDING");
    expect(mine.body.license).toBeNull();

    await submit(token, id, "license").expect(201);
    const ambos = await http()
      .get("/verification/identity/me")
      .set("Authorization", auth(token))
      .expect(200);
    expect(ambos.body.dni.status).toBe("PENDING");
    expect(ambos.body.license.status).toBe("PENDING");
  });

  it("exige el perfil de identidad completo antes de aceptar fotos", async () => {
    const user = await registerUser(app, { verified: false });

    const res = await submit(user.token, user.id, "dni").expect(400);
    expect(res.body.code).toBe("PERFIL_INCOMPLETO");
    expect(res.body.missing).toEqual(
      expect.arrayContaining(["DNI", "CUIL", "domicilio"]),
    );
  });

  it("el diagnóstico dice que este servidor revisa a mano", async () => {
    const { token } = await cuentaCompleta();

    const res = await http()
      .get("/verification/identity/diagnostics")
      .set("Authorization", auth(token))
      .expect(200);
    expect(res.body.mode).toBe("manual");
    expect(res.body.canVerifyAutomatically).toBe(false);
  });

  // ── El pedido de revisión ──────────────────────────────────────────────

  it("pedir la revisión manda el documento a la cola del admin", async () => {
    const { token, id } = await cuentaCompleta();
    await submit(token, id, "dni").expect(201);

    const pedida = await pedirRevision(token, "dni").expect(201);
    expect(pedida.body.status).toBe("MANUAL_REVIEW");
    expect(pedida.body.reviewRequestedAt).not.toBeNull();
    // Ya está pedida: no se vuelve a pedir, pero sí se pueden mandar fotos.
    expect(pedida.body.canRequestManualReview).toBe(false);
    expect(pedida.body.canResubmit).toBe(true);

    const admin = await createAdmin(app, prisma);
    const cola = await http()
      .get("/admin/verifications?status=MANUAL_REVIEW")
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(cola.body).toHaveLength(1);
    expect(cola.body[0].userId).toBe(id);
  });

  it("no deja pedir la revisión dos veces", async () => {
    const { token, id } = await cuentaCompleta();
    await submit(token, id, "dni").expect(201);
    await pedirRevision(token, "dni").expect(201);

    const res = await pedirRevision(token, "dni").expect(400);
    expect(res.body.code).toBe("REVIEW_NOT_AVAILABLE");
  });

  it("404 si se pide la revisión de un documento que nunca se envió", async () => {
    const { token } = await cuentaCompleta();

    await pedirRevision(token, "dni").expect(404);
  });

  // ── El veredicto del admin ─────────────────────────────────────────────

  async function enCola(kind: "dni" | "license" = "dni") {
    const { token, id } = await cuentaCompleta();
    await submit(token, id, kind).expect(201);
    await pedirRevision(token, kind).expect(201);
    const row = await prisma.documentVerification.findFirstOrThrow({
      where: { userId: id },
    });
    return { token, id, verificationId: row.id };
  }

  it("el admin aprueba y la documentación se conserva", async () => {
    const admin = await createAdmin(app, prisma);
    const { verificationId } = await enCola();

    const aprobada = await http()
      .patch(`/admin/verifications/${verificationId}/review`)
      .set("Authorization", auth(admin.token))
      .send({ status: "APPROVED", notes: "coincide con el perfil" })
      .expect(200);

    expect(aprobada.body.status).toBe("APPROVED");
    expect(aprobada.body.frontUrl).toContain("cloudinary");
    expect(cloudinary.destroyed).toHaveLength(0);
  });

  it("el admin rechaza y la documentación se borra del storage", async () => {
    const admin = await createAdmin(app, prisma);
    const { id, verificationId } = await enCola();

    await http()
      .patch(`/admin/verifications/${verificationId}/review`)
      .set("Authorization", auth(admin.token))
      .send({ status: "REJECTED" })
      .expect(200);

    expect(cloudinary.destroyed).toHaveLength(2);
    const row = await prisma.documentVerification.findFirstOrThrow({
      where: { userId: id },
    });
    expect(row.status).toBe("REJECTED");
    expect(row.frontUrl).toBeNull();
    expect(row.backUrl).toBeNull();
    expect(row.reasonCodes).toContain("RECHAZADO_POR_ADMIN");

    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.verificationStatus).toBe("REJECTED");
  });

  it("el motivo del rechazo le llega al usuario en su propio estado", async () => {
    const admin = await createAdmin(app, prisma);
    const { token, verificationId } = await enCola();

    await http()
      .patch(`/admin/verifications/${verificationId}/review`)
      .set("Authorization", auth(admin.token))
      .send({ status: "REJECTED" })
      .expect(200);

    const mine = await http()
      .get("/verification/identity/me")
      .set("Authorization", auth(token))
      .expect(200);
    expect(mine.body.dni.status).toBe("REJECTED");
    expect(mine.body.dni.reasons[0].code).toBe("RECHAZADO_POR_ADMIN");
    expect(mine.body.dni.reasons[0].message).toContain("rechaz");
  });

  it("no deja pedir la revisión de un documento ya aprobado", async () => {
    const admin = await createAdmin(app, prisma);
    const { token, verificationId } = await enCola();
    await http()
      .patch(`/admin/verifications/${verificationId}/review`)
      .set("Authorization", auth(admin.token))
      .send({ status: "APPROVED" })
      .expect(200);

    const res = await pedirRevision(token, "dni").expect(400);
    expect(res.body.code).toBe("REVIEW_NOT_AVAILABLE");
  });

  it("no deja reenviar fotos de un documento ya aprobado", async () => {
    const admin = await createAdmin(app, prisma);
    const { token, id, verificationId } = await enCola();
    await http()
      .patch(`/admin/verifications/${verificationId}/review`)
      .set("Authorization", auth(admin.token))
      .send({ status: "APPROVED" })
      .expect(200);

    const res = await submit(token, id, "dni").expect(400);
    expect(res.body.code).toBe("DOCUMENT_ALREADY_APPROVED");
  });

  // ── La cuenta queda verificada con LOS DOS documentos ──────────────────

  it("la cuenta queda VERIFIED recién con el DNI y la licencia aprobados", async () => {
    const admin = await createAdmin(app, prisma);
    const { token, id } = await cuentaCompleta();

    for (const kind of ["dni", "license"] as const) {
      await submit(token, id, kind).expect(201);
      await pedirRevision(token, kind).expect(201);
    }

    const cola = await http()
      .get("/admin/verifications?status=MANUAL_REVIEW")
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(cola.body).toHaveLength(2);

    // Con uno solo aprobado la cuenta todavía no está verificada.
    await http()
      .patch(`/admin/verifications/${cola.body[0].id}/review`)
      .set("Authorization", auth(admin.token))
      .send({ status: "APPROVED" })
      .expect(200);
    let user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.verificationStatus).toBe("ID_SUBMITTED");

    await http()
      .patch(`/admin/verifications/${cola.body[1].id}/review`)
      .set("Authorization", auth(admin.token))
      .send({ status: "APPROVED" })
      .expect(200);
    user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.verificationStatus).toBe("VERIFIED");
  });

  /**
   * UNA revisión viva por documento, y la última que se pide es la que vale.
   * Reenviar fotos tiene que poder SIEMPRE (salvo aprobado): si el pedido
   * pendiente bloqueara el reenvío, una persona que subió una foto movida
   * quedaría encerrada en una cola esperando a que alguien la mire.
   */
  it("reenviar fotos deja sin efecto la revisión pendiente", async () => {
    const { token, id } = await cuentaCompleta();
    await submit(token, id, "dni").expect(201);
    await pedirRevision(token, "dni").expect(201);

    const reenvio = await submit(token, id, "dni").expect(201);
    expect(reenvio.body.status).toBe("PENDING");
    expect(reenvio.body.reviewRequestedAt).toBeNull();

    const fila = await prisma.documentVerification.findFirstOrThrow({
      where: { userId: id, type: "DNI" },
    });
    expect(fila.status).toBe("PENDING");
    expect(fila.reviewRequestedAt).toBeNull();

    // Y se puede volver a pedir: la revisión va a ser sobre ESTAS fotos.
    const otraVez = await pedirRevision(token, "dni").expect(201);
    expect(otraVez.body.status).toBe("MANUAL_REVIEW");
  });

  it("una sola fila viva por documento: el reenvío reemplaza, no acumula", async () => {
    const { token, id } = await cuentaCompleta();
    await submit(token, id, "dni").expect(201);
    await submit(token, id, "dni").expect(201);

    const filas = await prisma.documentVerification.findMany({
      where: { userId: id, type: "DNI" },
    });
    expect(filas).toHaveLength(1);
  });
});
