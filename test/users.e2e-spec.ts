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
  TEST_PASSWORD,
  uniqueDni,
  uniquePhone,
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

  /**
   * Un dato que identifica a una persona no puede estar repartido entre dos
   * cuentas. Vale para el email, el teléfono, el DNI y el CUIL.
   */
  describe("una identidad, una sola cuenta", () => {
    const http = () => request(app.getHttpServer());

    it("no deja registrar el mismo email escrito con otras mayúsculas", async () => {
      const user = await registerUser(app);

      await http()
        .post("/auth/register/start")
        .send({ email: user.email.toUpperCase() })
        .expect(409);
    });

    it("guarda el email en minúsculas y deja entrar escribiéndolo como sea", async () => {
      const email = `MiXtO-${Date.now()}@Test.Local`;
      const user = await registerUser(app, { email });

      // Se guardó canonizado, no como vino.
      expect(user.email).toBe(email.toLowerCase());
      const row = await prisma.user.findUnique({ where: { id: user.id } });
      expect(row?.email).toBe(email.toLowerCase());

      // Y se puede entrar escribiéndolo de cualquiera de las dos formas.
      for (const escrito of [email, email.toLowerCase(), email.toUpperCase()]) {
        await http()
          .post("/auth/login")
          .send({ email: escrito, password: TEST_PASSWORD })
          .expect(201);
      }
    });

    it("la base rechaza un email con mayúsculas aunque se escriba directo", async () => {
      // La garantía no depende de que todos los caminos de la API se acuerden
      // de normalizar: si una dirección se guardara con mayúsculas, quien la
      // usa no podría iniciar sesión (la búsqueda compara exacto).
      const user = await registerUser(app);
      await expect(
        prisma.user.update({
          where: { id: user.id },
          data: { email: user.email.toUpperCase() },
        }),
      ).rejects.toThrow();
    });

    it("no deja que dos cuentas tengan el mismo teléfono", async () => {
      const phone = uniquePhone();
      const primero = await registerUser(app, { verified: false });
      await http()
        .patch("/users/me")
        .set("Authorization", bearer(primero.token))
        .send({ phone })
        .expect(200);

      // Ni desde el perfil de otra persona...
      const segundo = await registerUser(app, { verified: false });
      await http()
        .patch("/users/me")
        .set("Authorization", bearer(segundo.token))
        .send({ phone })
        .expect(409)
        .expect((res) =>
          expect(res.body.code).toBe("PHONE_ALREADY_REGISTERED"),
        );

      // ...ni registrando una cuenta nueva con ese número.
      await expect(registerUser(app, { phone })).rejects.toThrow();
    });

    it("acepta el mismo teléfono escrito distinto como lo que es: el mismo", async () => {
      const primero = await registerUser(app, { verified: false });
      await http()
        .patch("/users/me")
        .set("Authorization", bearer(primero.token))
        .send({ phone: "+54 9 11 3289 5416" })
        .expect(200);

      const segundo = await registerUser(app, { verified: false });
      await http()
        .patch("/users/me")
        .set("Authorization", bearer(segundo.token))
        .send({ phone: "005491132895416" })
        .expect(409);
    });

    it("dejar el propio teléfono como está no cuenta como repetido", async () => {
      const phone = uniquePhone();
      const user = await registerUser(app, { verified: false });
      await http()
        .patch("/users/me")
        .set("Authorization", bearer(user.token))
        .send({ phone })
        .expect(200);
      await http()
        .patch("/users/me")
        .set("Authorization", bearer(user.token))
        .send({ phone, firstName: "Ada" })
        .expect(200);
    });

    it("no deja que dos cuentas compartan el documento", async () => {
      const dni = uniqueDni();
      const primero = await registerUser(app, { verified: false });
      await http()
        .patch("/users/me")
        .set("Authorization", bearer(primero.token))
        .send({ dni, cuil: cuilFor(dni) })
        .expect(200);

      const segundo = await registerUser(app, { verified: false });
      await http()
        .patch("/users/me")
        .set("Authorization", bearer(segundo.token))
        .send({ dni })
        .expect(409)
        .expect((res) => expect(res.body.code).toBe("DNI_ALREADY_REGISTERED"));

      await http()
        .patch("/users/me")
        .set("Authorization", bearer(segundo.token))
        .send({ cuil: cuilFor(dni) })
        .expect(409)
        .expect((res) => expect(res.body.code).toBe("CUIL_ALREADY_REGISTERED"));
    });
  });
});
