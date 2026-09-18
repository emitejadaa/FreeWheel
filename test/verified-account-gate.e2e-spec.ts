import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  bearer,
  createListing,
  createVehicle,
  futureDate,
  registerUser,
} from "./helpers/factory";

/**
 * The verified-account gate: sensitive mutations require a fully verified
 * account (VERIFIED), while browsing, messaging, profile and the verification
 * endpoints themselves stay open to any authenticated user.
 */
describe("Verified-account gate", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  describe("blocks sensitive routes for an unverified account", () => {
    it("returns 403 ACCOUNT_NOT_VERIFIED on gated mutations", async () => {
      const user = await registerUser(app, { verified: false });
      const t = bearer(user.token);

      const expectGated = (res: request.Response) => {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("ACCOUNT_NOT_VERIFIED");
      };

      expectGated(
        await http()
          .post("/vehicles")
          .set("Authorization", t)
          .send({ brand: "Toyota", model: "Corolla", year: 2020 }),
      );
      expectGated(
        await http().post("/listings").set("Authorization", t).send({
          vehicleId: "00000000-0000-0000-0000-000000000000",
          title: "x",
          description: "y",
          pricePerDay: 5000,
          locationText: "CABA",
        }),
      );
      expectGated(
        await http()
          .post("/bookings")
          .set("Authorization", t)
          .send({
            listingId: "00000000-0000-0000-0000-000000000000",
            startDate: futureDate(3),
            endDate: futureDate(6),
          }),
      );
      expectGated(
        await http()
          .post(
            "/contracts/bookings/00000000-0000-0000-0000-000000000000/accept",
          )
          .set("Authorization", t),
      );
      expectGated(
        await http()
          .post(
            "/payments/bookings/00000000-0000-0000-0000-000000000000/sena-intent",
          )
          .set("Authorization", t),
      );
    });
  });

  describe("allows low-risk routes for an unverified account", () => {
    it("permits browsing, profile, conversations and verification endpoints", async () => {
      const user = await registerUser(app, { verified: false });
      const t = bearer(user.token);

      await http().get("/listings").expect(200);
      await http().get("/users/me").set("Authorization", t).expect(200);
      await http().get("/bookings/me").set("Authorization", t).expect(200);
      await http().get("/conversations/me").set("Authorization", t).expect(200);
      await http()
        .get("/verification/me/status")
        .set("Authorization", t)
        .expect(200);

      // The media signature endpoint is needed to upload the verification docs,
      // so it must NOT be gated (it may fail on config, but never with 403).
      const sig = await http()
        .post("/media/cloudinary-signature")
        .set("Authorization", t)
        .send({ folder: "identity" });
      expect(sig.status).not.toBe(403);
    });
  });

  describe("allows sensitive routes once fully verified", () => {
    it("lets a verified account create a vehicle and a listing", async () => {
      const owner = await registerUser(app); // verified by default
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      expect(listing.id).toEqual(expect.any(String));
    });
  });

  /**
   * EL DNI VENCIDO: la cuenta sigue verificada, pero no puede operar.
   *
   * Es la distinción que este bloque cuida. La persona no dejó de ser quien
   * es, así que no vuelve a empezar la verificación desde cero; lo que perdió
   * es el respaldo documental vigente, y todo lo que este guard protege tiene
   * plata y responsabilidad de por medio.
   */
  describe("con el DNI vencido", () => {
    it("bloquea lo sensible con un 403 que dice exactamente qué pasó", async () => {
      const owner = await registerUser(app);
      await prisma.user.update({
        where: { id: owner.id },
        data: { dniExpiresAt: new Date("2021-03-07T12:00:00.000Z") },
      });

      const res = await request(app.getHttpServer())
        .post("/vehicles")
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ brand: "Toyota", model: "Corolla", year: 2020 })
        .expect(403);

      expect(res.body.code).toBe("IDENTITY_DOCUMENT_EXPIRED");
      expect(res.body.reasons[0].code).toBe("DNI_VENCIDO");
      // El mensaje alcanza para saber qué hacer sin preguntarle a nadie.
      expect(res.body.message).toContain("7/3/2021");
    });

    it("la cuenta NO se desverifica: sigue VERIFIED y puede ver su perfil", async () => {
      const owner = await registerUser(app);
      await prisma.user.update({
        where: { id: owner.id },
        data: { dniExpiresAt: new Date("2021-03-07T12:00:00.000Z") },
      });

      const yo = await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${owner.token}`)
        .expect(200);
      expect(yo.body.verificationStatus).toBe("VERIFIED");
    });

    it("deja LEER lo que ya existe: bloquea escrituras, no consultas", async () => {
      // Bloquear las lecturas no protege nada y deja a alguien sin poder
      // mirar sus propias reservas, que se ve como una cuenta rota.
      const owner = await registerUser(app);
      await prisma.user.update({
        where: { id: owner.id },
        data: { dniExpiresAt: new Date("2021-03-07T12:00:00.000Z") },
      });

      // Una ruta GET que SÍ exige cuenta verificada. Que conteste 404 (la
      // reserva no existe) y no 403 es la prueba de que el guard la dejó
      // pasar: el bloqueo por DNI vencido no llegó a correr.
      await request(app.getHttpServer())
        .get("/payments/bookings/00000000-0000-0000-0000-000000000000/status")
        .set("Authorization", `Bearer ${owner.token}`)
        .expect(404);
    });

    it("un vencimiento desconocido no bloquea nada", async () => {
      // Hay cuentas verificadas de antes de que este dato existiera.
      const owner = await registerUser(app);
      await prisma.user.update({
        where: { id: owner.id },
        data: { dniExpiresAt: null },
      });
      const vehicle = await createVehicle(app, owner.token);
      expect(vehicle.id).toEqual(expect.any(String));
    });
  });
});
