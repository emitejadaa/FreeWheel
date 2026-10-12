import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import { bearer, registerUser } from "./helpers/factory";
import { FAKE_CLOUD_NAME } from "./helpers/cloudinary.fake";

/**
 * Quién puede gastar la cuota de la API de IA.
 *
 * Cada llamada a estas rutas consume cuota de UNA clave nuestra, así que una ruta
 * abierta es una factura ajena y, sobre todo, es dejar sin IA a todo el proyecto
 * cuando alguien la agota. Estas pruebas van por HTTP a propósito: lo que hay que
 * comprobar es que los guardas estén realmente puestos en la ruta, no que la
 * lógica de permisos funcione en abstracto.
 *
 * No hace falta que Groq esté configurado: el 401 y el 403 se contestan antes de
 * salir a la red.
 */
describe("Rutas de IA: quién gasta la cuota", () => {
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

  const IMAGEN = "data:image/png;base64,iVBORw0KGgo=";

  it("GET /ai/health es público: se puede mirar sin cuenta", async () => {
    const res = await request(app.getHttpServer())
      .get("/ai/health")
      .expect(200);
    // Dice si está configurado, nunca la clave.
    expect(res.body).toHaveProperty("configured");
    expect(JSON.stringify(res.body)).not.toMatch(/gsk_/);
  });

  it("GET /ai/health?probe=1 sin cuenta: 403 (probar gasta cuota)", async () => {
    await request(app.getHttpServer()).get("/ai/health?probe=1").expect(403);
  });

  it("GET /ai/health?probe=1 con una cuenta común: 403", async () => {
    const user = await registerUser(app);
    await request(app.getHttpServer())
      .get("/ai/health?probe=1")
      .set("Authorization", bearer(user.token))
      .expect(403);
  });

  it("GET /ai/health?probe=1 como admin: pasa el permiso", async () => {
    const admin = await registerUser(app);
    await prisma.user.update({
      where: { id: admin.id },
      data: { role: "ADMIN" },
    });
    // Hay que volver a loguearse: el rol viaja dentro del token.
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: admin.email, password: admin.password })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get("/ai/health?probe=1")
      .set("Authorization", bearer(login.body.accessToken as string));

    // Sin clave de Groq en las pruebas no puede probar nada, pero lo que importa
    // es que ya no lo rechaza por permisos.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("POST /ai/vision sin cuenta: 401", async () => {
    await request(app.getHttpServer())
      .post("/ai/vision")
      .send({ imageDataUrl: IMAGEN })
      .expect(401);
  });

  it("POST /ai/vision con cuenta: ya no es un problema de permisos", async () => {
    const user = await registerUser(app);
    const res = await request(app.getHttpServer())
      .post("/ai/vision")
      .set("Authorization", bearer(user.token))
      .send({ imageDataUrl: IMAGEN });
    expect(res.status).not.toBe(401);
  });

  it("POST /ai/transcribe sigue pidiendo cuenta: 401", async () => {
    await request(app.getHttpServer())
      .post("/ai/transcribe")
      .send({ audioUrl: "https://cdn.example.com/audio.webm" })
      .expect(401);
  });

  /**
   * El servidor DESCARGA la URL del audio: si aceptara cualquiera, sería una
   * forma de hacerlo pedir hosts internos o metadatos de la nube (SSRF).
   */
  it("POST /ai/transcribe solo descarga audios de nuestro Cloudinary", async () => {
    const user = await registerUser(app);
    for (const audioUrl of [
      "https://cdn.example.com/audio.webm",
      "http://169.254.169.254/latest/meta-data/",
      "https://res.cloudinary.com/otra-cuenta/video/upload/v1/nota.webm",
    ]) {
      await request(app.getHttpServer())
        .post("/ai/transcribe")
        .set("Authorization", bearer(user.token))
        .send({ audioUrl })
        .expect(400);
    }

    // Una de nuestra cuenta pasa el control (y sin clave de Groq, para ahí).
    const res = await request(app.getHttpServer())
      .post("/ai/transcribe")
      .set("Authorization", bearer(user.token))
      .send({
        audioUrl: `https://res.cloudinary.com/${FAKE_CLOUD_NAME}/video/upload/v1/chat/nota.webm`,
      });
    expect(res.status).not.toBe(400);
  });

  it("POST /ai/chat rechaza conversaciones desmedidas (gastan nuestra cuota)", async () => {
    const demasiados = Array.from({ length: 41 }, () => ({
      role: "user",
      content: "hola",
    }));
    await request(app.getHttpServer())
      .post("/ai/chat")
      .send({ messages: demasiados })
      .expect(400);

    await request(app.getHttpServer())
      .post("/ai/chat")
      .send({ messages: [{ role: "user", content: "x".repeat(60_000) }] })
      .expect(400);
  });

  /**
   * El chatbot de ayuda queda a propósito abierto: atiende a visitantes sin
   * cuenta, que es la mitad de para qué está. Lo que lo sostiene no es un guarda
   * sino un tope por minuto y por IP más bajo que el global.
   */
  it("POST /ai/chat es público, pero con tope propio", async () => {
    const res = await request(app.getHttpServer())
      .post("/ai/chat")
      .send({ messages: [{ role: "user", content: "hola" }] });
    expect(res.status).not.toBe(401);
  });
});
