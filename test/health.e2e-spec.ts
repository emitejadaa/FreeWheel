import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";

describe("Health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET / responds 200 (liveness)", async () => {
    await request(app.getHttpServer()).get("/").expect(200);
  });
});
