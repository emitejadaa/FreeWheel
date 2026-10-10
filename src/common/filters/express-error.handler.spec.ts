import express from "express";
import request from "supertest";
import { expressErrorHandler } from "./express-error.handler";

interface Respuesta {
  statusCode?: number;
  code?: string;
  message?: string;
  errorId?: string;
}

/**
 * Lo que contesta la API cuando el pedido falla antes de llegar a Nest. Antes
 * todo era un 503 "API_NO_DISPONIBLE" con el mensaje crudo: un JSON mal
 * escrito por el cliente se veía como una caída del servidor.
 */
describe("expressErrorHandler", () => {
  const NODE_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = NODE_ENV;
  });

  function servidor(fallaDeArranque?: Error) {
    const app = express();
    app.use(express.json({ limit: "1kb" }));
    if (fallaDeArranque) app.use((_req, _res, next) => next(fallaDeArranque));
    app.post("/x", (_req, res) => {
      res.json({ ok: true });
    });
    app.use(expressErrorHandler);
    return app;
  }

  it("un JSON mal escrito es un 400 del cliente, sin el detalle del parser", async () => {
    const res = await request(servidor())
      .post("/x")
      .set("Content-Type", "application/json")
      .send("{roto")
      .expect(400);
    expect(res.body).toMatchObject({ statusCode: 400, code: "INVALID_JSON" });
    expect(JSON.stringify(res.body)).not.toMatch(/position|Unexpected/);
  });

  it("un cuerpo demasiado grande es un 413", async () => {
    const res = await request(servidor())
      .post("/x")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ texto: "x".repeat(4096) }))
      .expect(413);
    expect((res.body as Respuesta).code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("si Nest no arrancó, en producción no cuenta el motivo", async () => {
    process.env.NODE_ENV = "production";
    const res = await request(
      servidor(new Error("Can't reach database server at `db.interno:5432`")),
    )
      .post("/x")
      .send({})
      .expect(503);
    const body = res.body as Respuesta;
    expect(body.code).toBe("API_NO_DISPONIBLE");
    expect(body.errorId).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toContain("db.interno");
  });

  it("fuera de producción el motivo viaja, para diagnosticar desde el navegador", async () => {
    process.env.NODE_ENV = "development";
    const res = await request(servidor(new Error("Falta JWT_SECRET")))
      .post("/x")
      .send({})
      .expect(503);
    expect((res.body as Respuesta).message).toBe("Falta JWT_SECRET");
  });
});
