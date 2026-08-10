import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  bearer,
  createListing,
  createVehicle,
  cuilFor,
  futureDate,
  registerUser,
  uniqueDni,
} from "./helpers/factory";

describe("Users", () => {
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

  it("GET /users/me returns the profile without the password", async () => {
    const user = await registerUser(app);
    const res = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${user.token}`)
      .expect(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body.email).toBe(user.email);
    expect(res.body.password).toBeUndefined();
  });

  it("GET /users/me requires a token", async () => {
    await request(app.getHttpServer()).get("/users/me").expect(401);
  });

  it("PATCH /users/me updates allowed fields", async () => {
    // Not verified: identity-backing fields (firstName, dni, ...) are only
    // editable before the account reaches VERIFIED.
    const user = await registerUser(app, { verified: false });
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ firstName: "Grace", phone: "+5491133334444" })
      .expect(200);
    expect(res.body.firstName).toBe("Grace");
    expect(res.body.phone).toBe("+5491133334444");
  });

  it("PATCH /users/me rejects an invalid profile photo URL", async () => {
    const user = await registerUser(app);
    await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ profilePhotoUrl: "not-a-url" })
      .expect(400);
  });

  it("PATCH /users/me stores dni/cuil/address, normalizing the CUIL", async () => {
    const user = await registerUser(app, { verified: false });
    const dni = "12345678";
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.token}`)
      .send({
        dni,
        cuil: "20-12345678-6",
        address: "Av. Corrientes 1234, CABA",
      })
      .expect(200);
    expect(res.body.dni).toBe(dni);
    expect(res.body.cuil).toBe("20123456786");
    expect(res.body.address).toBe("Av. Corrientes 1234, CABA");
  });

  it("PATCH /users/me rejects a CUIL with a bad check digit (400)", async () => {
    const user = await registerUser(app, { verified: false });
    await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ cuil: "20-12345678-7" })
      .expect(400);
  });

  it("PATCH /users/me rejects a CUIL that does not embed the DNI (400 CUIL_DNI_MISMATCH)", async () => {
    const user = await registerUser(app, { verified: false });
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ dni: "87654321", cuil: "20-12345678-6" })
      .expect(400);
    expect(res.body.code).toBe("CUIL_DNI_MISMATCH");
  });

  it("PATCH /users/me returns 409 when the DNI belongs to another account", async () => {
    const dni = uniqueDni();
    const first = await registerUser(app, { verified: false });
    await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${first.token}`)
      .send({ dni, cuil: cuilFor(dni), address: "Calle Falsa 123, CABA" })
      .expect(200);

    const second = await registerUser(app, { verified: false });
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${second.token}`)
      .send({ dni })
      .expect(409);
    expect(res.body.code).toBe("DNI_ALREADY_REGISTERED");
  });

  it("PATCH /users/me locks identity fields once the account is VERIFIED (403)", async () => {
    const user = await registerUser(app); // verified by default
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ firstName: "Nueva", dni: uniqueDni() })
      .expect(403);
    expect(res.body.code).toBe("IDENTITY_FIELDS_LOCKED");
    expect(res.body.fields).toEqual(
      expect.arrayContaining(["firstName", "dni"]),
    );

    // Non-identity fields remain editable after verification.
    await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ displayName: "Sigo pudiendo", phone: "+5491155556666" })
      .expect(200);
  });

  /**
   * Quién ve la foto de perfil.
   *
   * Estas pruebas van por HTTP a propósito: la lógica ya está probada aparte
   * (photo-visibility.interceptor.spec.ts), lo que falta comprobar es que el
   * interceptor esté realmente enganchado a la aplicación. Un control de
   * privacidad bien escrito pero sin registrar no tapa nada.
   */
  describe("quién ve la foto de perfil", () => {
    const FOTO = "https://cdn.example.com/ignacio.jpg";

    /** Registra a alguien con foto y el ajuste pedido. */
    async function conFoto(visibility: "EVERYONE" | "BOOKED") {
      const user = await registerUser(app);
      await request(app.getHttpServer())
        .patch("/users/me")
        .set("Authorization", bearer(user.token))
        .send({ profilePhotoUrl: FOTO, profilePhotoVisibility: visibility })
        .expect(200);
      return user;
    }

    it("guarda el ajuste y lo devuelve en el perfil propio", async () => {
      const dueño = await conFoto("BOOKED");
      const res = await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", bearer(dueño.token))
        .expect(200);

      expect(res.body.profilePhotoUrl).toBe(FOTO);
      expect(res.body.profilePhotoVisibility).toBe("BOOKED");
    });

    it("rechaza un valor que no existe", async () => {
      const user = await registerUser(app);
      await request(app.getHttpServer())
        .patch("/users/me")
        .set("Authorization", bearer(user.token))
        .send({ profilePhotoVisibility: "SOLO_MIS_AMIGOS" })
        .expect(400);
    });

    it("con EVERYONE, cualquiera ve la foto en el perfil público", async () => {
      const dueño = await conFoto("EVERYONE");
      const curioso = await registerUser(app);

      const res = await request(app.getHttpServer())
        .get(`/users/${dueño.id}`)
        .set("Authorization", bearer(curioso.token))
        .expect(200);

      expect(res.body.profilePhotoUrl).toBe(FOTO);
      // El ajuste ajeno no viaja: no le sirve a nadie más que a su dueño.
      expect(res.body.profilePhotoVisibility).toBeUndefined();
    });

    it("con BOOKED, un desconocido no ve la foto", async () => {
      const dueño = await conFoto("BOOKED");
      const curioso = await registerUser(app);

      const res = await request(app.getHttpServer())
        .get(`/users/${dueño.id}`)
        .set("Authorization", bearer(curioso.token))
        .expect(200);

      expect(res.body.profilePhotoUrl).toBeNull();
      // El resto del perfil sigue llegando: se tapa la foto, no la persona.
      expect(res.body.id).toBe(dueño.id);
      expect(res.body.firstName).toBeTruthy();
    });

    it("con BOOKED, quien tiene una reserva en común sí la ve", async () => {
      const dueño = await conFoto("BOOKED");
      const inquilino = await registerUser(app);

      const vehiculo = await createVehicle(app, dueño.token);
      const publicacion = await createListing(app, dueño.token, vehiculo.id);
      await prisma.booking.create({
        data: {
          listingId: publicacion.id,
          vehicleId: vehiculo.id,
          ownerId: dueño.id,
          renterId: inquilino.id,
          startDate: new Date(futureDate(10)),
          endDate: new Date(futureDate(12)),
          pricePerDaySnapshot: 5000,
          totalPriceSnapshot: 10000,
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/users/${dueño.id}`)
        .set("Authorization", bearer(inquilino.token))
        .expect(200);

      expect(res.body.profilePhotoUrl).toBe(FOTO);
    });

    it("con BOOKED, una reserva rechazada no alcanza", async () => {
      const dueño = await conFoto("BOOKED");
      const inquilino = await registerUser(app);

      const vehiculo = await createVehicle(app, dueño.token);
      const publicacion = await createListing(app, dueño.token, vehiculo.id);
      await prisma.booking.create({
        data: {
          listingId: publicacion.id,
          vehicleId: vehiculo.id,
          ownerId: dueño.id,
          renterId: inquilino.id,
          startDate: new Date(futureDate(10)),
          endDate: new Date(futureDate(12)),
          pricePerDaySnapshot: 5000,
          totalPriceSnapshot: 10000,
          status: "REJECTED",
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/users/${dueño.id}`)
        .set("Authorization", bearer(inquilino.token))
        .expect(200);

      expect(res.body.profilePhotoUrl).toBeNull();
    });

    it("con EVERYONE, la foto llega en el dueño de una publicación", async () => {
      const dueño = await conFoto("EVERYONE");
      const vehiculo = await createVehicle(app, dueño.token);
      const publicacion = await createListing(app, dueño.token, vehiculo.id);
      const curioso = await registerUser(app);

      const res = await request(app.getHttpServer())
        .get(`/listings/${publicacion.id}`)
        .set("Authorization", bearer(curioso.token))
        .expect(200);

      expect(res.body.owner.profilePhotoUrl).toBe(FOTO);
      expect(res.body.owner.profilePhotoVisibility).toBeUndefined();
    });

    it("con BOOKED, la foto tampoco se filtra por el dueño de una publicación", async () => {
      const dueño = await conFoto("BOOKED");
      const vehiculo = await createVehicle(app, dueño.token);
      const publicacion = await createListing(app, dueño.token, vehiculo.id);
      const curioso = await registerUser(app);

      const res = await request(app.getHttpServer())
        .get(`/listings/${publicacion.id}`)
        .set("Authorization", bearer(curioso.token))
        .expect(200);

      expect(res.body.owner.profilePhotoUrl).toBeNull();
      // Y el auto se sigue viendo entero: lo único que se tapa es la cara.
      expect(res.body.id).toBe(publicacion.id);
    });
  });
});
