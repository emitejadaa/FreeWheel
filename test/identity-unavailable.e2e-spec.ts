import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  cuilFor,
  registerUser,
  setIdentityProfile,
  uniqueDni,
} from "./helpers/factory";
import { documentUrls, FakeCloudinaryService } from "./helpers/cloudinary.fake";
import { FakePythonDocverifyService } from "./helpers/identity.fake";

/**
 * UN SERVIDOR QUE NO PUEDE VERIFICAR SOLO
 *
 * Es el caso del deploy en Vercel: serverless no tiene Python ni el binario de
 * tesseract, y no los puede tener. Antes eso degradaba a modo "manual" en
 * silencio y el resultado era el peor posible: TODA submission caía sola en
 * MANUAL_REVIEW sin que nadie la pidiera, y la siguiente se rechazaba con
 * "está esperando la revisión de un administrador". La persona quedaba
 * encerrada en una cola que nunca pidió, sin forma de reintentar.
 *
 * Ahora eso es el modo "unavailable" y termina en FAILED con el motivo puesto,
 * que deja las dos salidas abiertas: reenviar fotos, o pedir revisión manual.
 */
describe("Verificación documental sin verificador (unavailable)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cloudinary: FakeCloudinaryService;
  let docverify: FakePythonDocverifyService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    ({ app, prisma, cloudinary, docverify } = await createTestApp({
      docverifyMode: "auto",
      // Lo que hace que "auto" no se pueda cumplir: no hay con qué analizar.
      docverifyAvailable: false,
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
    cloudinary.reset();
    docverify.reset();
  });

  /** Una cuenta con el perfil completo, lista para mandar documentos. */
  async function cuenta() {
    const user = await registerUser(app, { verified: false });
    const dni = uniqueDni();
    await setIdentityProfile(app, user.token, { dni, cuil: cuilFor(dni) });
    return user;
  }

  const submit = (token: string, id: string) =>
    http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(token))
      .send(documentUrls(id, "dni"));

  it("queda FAILED con el motivo, NO encolado en revisión manual", async () => {
    const user = await cuenta();

    const res = await submit(user.token, user.id).expect(201);

    expect(res.body.status).toBe("FAILED");
    expect(res.body.reasons.map((r: { code: string }) => r.code)).toContain(
      "VERIFICACION_NO_DISPONIBLE",
    );
    // El motivo dice QUÉ falta, no solo que algo falló.
    expect(res.body.reasons[0].message).toMatch(/no está disponible/i);
    // Nadie pidió una revisión manual, así que no hay ninguna pendiente.
    expect(res.body.reviewRequestedAt).toBeNull();
  });

  it("se puede reenviar las veces que haga falta (era el bug)", async () => {
    const user = await cuenta();

    // Tres intentos seguidos: los tres entran. Antes el segundo daba 400.
    for (let i = 0; i < 3; i += 1) {
      const res = await submit(user.token, user.id).expect(201);
      expect(res.body.status).toBe("FAILED");
      expect(res.body.canResubmit).toBe(true);
    }

    // Y siempre hay UNA sola revisión viva.
    expect(
      await prisma.documentVerification.count({
        where: { userId: user.id, type: "DNI" },
      }),
    ).toBe(1);
  });

  it("y desde ahí se puede pedir revisión manual, que es la salida", async () => {
    const user = await cuenta();
    const enviado = await submit(user.token, user.id).expect(201);
    expect(enviado.body.canRequestManualReview).toBe(true);

    const pedido = await http()
      .post("/verification/identity/dni/request-review")
      .set("Authorization", auth(user.token))
      .expect(201);
    expect(pedido.body.status).toBe("MANUAL_REVIEW");

    // Y aun con la manual pedida se puede volver a mandar fotos.
    const reenvio = await submit(user.token, user.id).expect(201);
    expect(reenvio.body.status).toBe("FAILED");
  });

  it("el diagnóstico dice que degradó y por qué", async () => {
    const user = await cuenta();

    const res = await http()
      .get("/verification/identity/diagnostics")
      .set("Authorization", auth(user.token))
      .expect(200);

    // Esto es lo que antes no existía: el servidor decía "auto" y se
    // comportaba como otra cosa, sin explicar el salto en ningún lado.
    expect(res.body.mode).toBe("unavailable");
    expect(res.body.configured).toBe("auto");
    expect(res.body.canVerifyAutomatically).toBe(false);
    expect(typeof res.body.degradedReason).toBe("string");
    expect(res.body.degradedReason.length).toBeGreaterThan(0);
  });

  it("el motivo del fallo viaja también en el informe de extracción", async () => {
    const user = await cuenta();
    const res = await submit(user.token, user.id).expect(201);

    expect(res.body.extraction.mode).toBe("unavailable");
    expect(res.body.extraction.degradedReason).toBeTruthy();
    // No hay nada leído porque no corrió nada: eso también es información.
    expect(res.body.extraction.extracted).toBeNull();
    expect(res.body.extraction.matrix).toEqual([]);
  });

  it("la cuenta NO queda verificada", async () => {
    const user = await cuenta();
    await submit(user.token, user.id).expect(201);

    const fila = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(fila.verificationStatus).not.toBe("VERIFIED");
  });
});
