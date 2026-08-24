import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  createAdmin,
  createListing,
  createVehicle,
  futureDate,
  registerUser,
  setIdentityProfile,
  TEST_PASSWORD,
  uniquePhone,
} from "./helpers/factory";
import {
  documentUrls,
  FakeCloudinaryService,
} from "./helpers/cloudinary.fake";

describe("Admin", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cloudinary: FakeCloudinaryService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    ({ app, prisma, cloudinary } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
    cloudinary.reset();
  });

  it("forbids non-admins from admin routes (403)", async () => {
    const user = await registerUser(app);
    await http()
      .get("/admin/users")
      .set("Authorization", auth(user.token))
      .expect(403);
  });

  it("lists and fetches users", async () => {
    const admin = await createAdmin(app, prisma);
    const user = await registerUser(app);

    const list = await http()
      .get("/admin/users")
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(Array.isArray(list.body)).toBe(true);

    await http()
      .get(`/admin/users/${user.id}`)
      .set("Authorization", auth(admin.token))
      .expect(200);
  });

  it("suspends a user (who then cannot log in) and changes roles", async () => {
    const admin = await createAdmin(app, prisma);
    const user = await registerUser(app);

    await http()
      .patch(`/admin/users/${user.id}/status`)
      .set("Authorization", auth(admin.token))
      .send({ status: "SUSPENDED" })
      .expect(200);
    await http()
      .post("/auth/login")
      .send({ email: user.email, password: user.password })
      .expect(401);

    await http()
      .patch(`/admin/users/${user.id}/role`)
      .set("Authorization", auth(admin.token))
      .send({ role: "ADMIN" })
      .expect(200)
      .expect((res) => expect(res.body.role).toBe("ADMIN"));
  });

  it("cannot delete itself", async () => {
    const admin = await createAdmin(app, prisma);
    await http()
      .delete(`/admin/users/${admin.id}`)
      .set("Authorization", auth(admin.token))
      .expect(400);
  });

  it("lists and reviews a document verification", async () => {
    const admin = await createAdmin(app, prisma);
    const user = await registerUser(app, { verified: false });
    await setIdentityProfile(app, user.token);
    await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "dni"))
      .expect(201);

    // Un admin puede filtrar por tipo y por estado.
    const list = await http()
      .get("/admin/verifications?type=DNI")
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(list.body).toHaveLength(1);
    const verificationId = list.body[0].id;

    const detail = await http()
      .get(`/admin/verifications/${verificationId}`)
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(detail.body.type).toBe("DNI");

    // El admin sí ve las fotos, con URLs firmadas efímeras.
    const docs = await http()
      .get(`/admin/verifications/${verificationId}/documents`)
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(docs.body.documents.front).toContain("cloudinary");
  });

  it("rejects a document verification and deletes its files", async () => {
    const admin = await createAdmin(app, prisma);
    const user = await registerUser(app, { verified: false });
    await setIdentityProfile(app, user.token);
    await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "dni"))
      .expect(201);

    const list = await http()
      .get("/admin/verifications")
      .set("Authorization", auth(admin.token))
      .expect(200);

    const rejected = await http()
      .patch(`/admin/verifications/${list.body[0].id}/review`)
      .set("Authorization", auth(admin.token))
      .send({ status: "REJECTED", notes: "foto de otra persona" })
      .expect(200);

    expect(rejected.body.status).toBe("REJECTED");
    // La documentación rechazada se borra del storage y de la fila.
    expect(rejected.body.frontUrl).toBeNull();
    expect(rejected.body.backUrl).toBeNull();
    expect(cloudinary.destroyed).toHaveLength(2);
  });

  it("manages listings (status change + permanent delete)", async () => {
    const admin = await createAdmin(app, prisma);
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    const listing = await createListing(app, owner.token, vehicle.id);

    await http()
      .get("/admin/listings")
      .set("Authorization", auth(admin.token))
      .expect(200);
    await http()
      .patch(`/admin/listings/${listing.id}/status`)
      .set("Authorization", auth(admin.token))
      .send({ status: "PAUSED" })
      .expect(200);
    await http()
      .delete(`/admin/listings/${listing.id}`)
      .set("Authorization", auth(admin.token))
      .expect(200);
  });

  it("lists and fetches bookings", async () => {
    const admin = await createAdmin(app, prisma);
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    const listing = await createListing(app, owner.token, vehicle.id);
    const renter = await registerUser(app);
    const booking = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({
        listingId: listing.id,
        startDate: futureDate(5),
        endDate: futureDate(8),
      })
      .expect(201);

    const list = await http()
      .get("/admin/bookings")
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);

    await http()
      .get(`/admin/bookings/${booking.body.id}`)
      .set("Authorization", auth(admin.token))
      .expect(200);
  });

  it("permanently deletes a user", async () => {
    const admin = await createAdmin(app, prisma);
    const user = await registerUser(app);
    await http()
      .delete(`/admin/users/${user.id}`)
      .set("Authorization", auth(admin.token))
      .expect(200)
      .expect((res) => expect(res.body.deleted).toBe(true));

    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
  });

  /**
   * Borrar una cuenta de verdad — lo que hace falta para reciclar cuentas de
   * demostración durante el desarrollo, y lo que NO se hace en producción.
   */
  describe("borrado definitivo de cuentas", () => {
    it("dice si el borrado está habilitado, para que el panel sepa qué mostrar", async () => {
      const admin = await createAdmin(app, prisma);
      await http()
        .get("/admin/settings")
        .set("Authorization", auth(admin.token))
        .expect(200)
        .expect((res) => {
          expect(res.body.hardDeleteAccounts).toBe(true);
          expect(res.body.hardDeleteDisabledReason).toBeNull();
        });
    });

    it("libera el email y el teléfono para volver a registrarlos", async () => {
      const admin = await createAdmin(app, prisma);
      const phone = uniquePhone();
      const user = await registerUser(app);
      await prisma.user.update({ where: { id: user.id }, data: { phone } });

      // Mientras la cuenta existe, sus datos están tomados.
      await http()
        .post("/auth/register/start")
        .send({ email: user.email })
        .expect(409);

      const deleted = await http()
        .delete(`/admin/users/${user.id}`)
        .set("Authorization", auth(admin.token))
        .expect(200);
      expect(deleted.body.freed).toEqual({ email: user.email, phone });

      // Y ahora se pueden volver a usar los dos, que es todo el punto.
      const reused = await registerUser(app, { email: user.email });
      expect(reused.email).toBe(user.email);
      await prisma.user.update({ where: { id: reused.id }, data: { phone } });
    });

    it("borra también una cuenta con reservas, contrato y chat", async () => {
      const admin = await createAdmin(app, prisma);
      const owner = await registerUser(app);
      const renter = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      const booking = await http()
        .post("/bookings")
        .set("Authorization", auth(renter.token))
        .send({
          listingId: listing.id,
          startDate: futureDate(5),
          endDate: futureDate(8),
        })
        .expect(201);

      // Aceptar la reserva crea el contrato, que referencia a la reserva con
      // Restrict: es la fila que hacía fallar el borrado con un error de clave
      // foránea antes de que se la borrara en orden.
      await http()
        .patch(`/bookings/${booking.body.id}/accept`)
        .set("Authorization", auth(owner.token))
        .expect(200);
      expect(await prisma.contract.count()).toBe(1);

      await http()
        .delete(`/admin/users/${owner.id}`)
        .set("Authorization", auth(admin.token))
        .expect(200);

      expect(await prisma.user.findUnique({ where: { id: owner.id } })).toBeNull();
      expect(await prisma.contract.count()).toBe(0);
      expect(await prisma.booking.count()).toBe(0);
      expect(await prisma.listing.count()).toBe(0);
      expect(await prisma.vehicle.count()).toBe(0);
      // Quien alquilaba no se toca: solo se va la cuenta borrada.
      expect(
        await prisma.user.findUnique({ where: { id: renter.id } }),
      ).not.toBeNull();
    });

    it("deja bien el promedio de quien había recibido sus reseñas", async () => {
      const admin = await createAdmin(app, prisma);
      const owner = await registerUser(app);
      const renter = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      // Una reseña de 5 escrita por quien alquiló, hecha a mano: llegar hasta
      // una reserva COMPLETED y pagada es el trabajo de reviews.e2e-spec.
      const booking = await prisma.booking.create({
        data: {
          listingId: listing.id,
          vehicleId: vehicle.id,
          ownerId: owner.id,
          renterId: renter.id,
          startDate: new Date(futureDate(5)),
          endDate: new Date(futureDate(8)),
          status: "COMPLETED",
          pricePerDaySnapshot: 1000,
          totalPriceSnapshot: 3000,
        },
      });
      await prisma.review.create({
        data: {
          bookingId: booking.id,
          authorId: renter.id,
          targetUserId: owner.id,
          listingId: listing.id,
          rating: 5,
        },
      });
      await prisma.user.update({
        where: { id: owner.id },
        data: { ratingAverage: 5, ratingCount: 1 },
      });
      await prisma.listing.update({
        where: { id: listing.id },
        data: { ratingAverage: 5, ratingCount: 1 },
      });

      // Al borrar a quien la escribió, la reseña se va por cascada. El promedio
      // del dueño no puede quedar contando una reseña que ya no existe.
      await http()
        .delete(`/admin/users/${renter.id}`)
        .set("Authorization", auth(admin.token))
        .expect(200);

      const dueño = await prisma.user.findUnique({ where: { id: owner.id } });
      expect(dueño?.ratingCount).toBe(0);
      expect(dueño?.ratingAverage).toBeNull();
      const aviso = await prisma.listing.findUnique({
        where: { id: listing.id },
      });
      expect(aviso?.ratingCount).toBe(0);
      expect(aviso?.ratingAverage).toBeNull();
    });

    it("deja registrado en la auditoría que la cuenta existió", async () => {
      const admin = await createAdmin(app, prisma);
      const user = await registerUser(app);

      await http()
        .delete(`/admin/users/${user.id}`)
        .set("Authorization", auth(admin.token))
        .expect(200);

      const log = await prisma.auditLog.findFirst({
        where: { action: "admin.user.delete.permanent", entityId: user.id },
      });
      expect(log).not.toBeNull();
      expect(log?.actorId).toBe(admin.id);
      expect(log?.metadata).toMatchObject({ email: user.email });
    });

    it("borra a otro admin, pero nunca deja el panel sin ninguno", async () => {
      const admin = await createAdmin(app, prisma);
      const otro = await createAdmin(app, prisma);

      // Borrar a OTRO admin se puede: quien borra sigue siendo admin, así que
      // el panel nunca queda sin nadie.
      await http()
        .delete(`/admin/users/${otro.id}`)
        .set("Authorization", auth(admin.token))
        .expect(200);

      // Borrarse a uno mismo, no — y ahí se cierra el caso: es la única forma
      // en que el sistema podría quedarse sin ningún admin.
      await http()
        .delete(`/admin/users/${admin.id}`)
        .set("Authorization", auth(admin.token))
        .expect(400);
      expect(
        await prisma.user.findUnique({ where: { id: admin.id } }),
      ).not.toBeNull();
    });

    it("un admin no puede sacarse el rol a sí mismo", async () => {
      const admin = await createAdmin(app, prisma);

      // No hay alta de admin por API: si se lo saca, no puede volver a entrar.
      await http()
        .patch(`/admin/users/${admin.id}/role`)
        .set("Authorization", auth(admin.token))
        .send({ role: "USER" })
        .expect(400);

      // Sigue pudiendo entrar al panel.
      await http()
        .get("/admin/users")
        .set("Authorization", auth(admin.token))
        .expect(200);
    });

    it("un admin no puede suspenderse a sí mismo y quedarse afuera", async () => {
      const admin = await createAdmin(app, prisma);
      await http()
        .patch(`/admin/users/${admin.id}/status`)
        .set("Authorization", auth(admin.token))
        .send({ status: "SUSPENDED" })
        .expect(400);
    });

    describe("con el borrado apagado (como en producción)", () => {
      beforeEach(() => {
        process.env.ALLOW_ACCOUNT_HARD_DELETE = "false";
      });
      afterEach(() => {
        delete process.env.ALLOW_ACCOUNT_HARD_DELETE;
      });

      it("contesta 403 y explica que hay que suspender o dar de baja", async () => {
        const admin = await createAdmin(app, prisma);
        const user = await registerUser(app);

        await http()
          .delete(`/admin/users/${user.id}`)
          .set("Authorization", auth(admin.token))
          .expect(403)
          .expect((res) => {
            expect(res.body.code).toBe("ACCOUNT_HARD_DELETE_DISABLED");
            expect(res.body.message).toMatch(/suspenden o se dan de baja/);
          });

        // La cuenta sigue ahí, con sus datos tomados: es lo que se busca.
        expect(
          await prisma.user.findUnique({ where: { id: user.id } }),
        ).not.toBeNull();
        await http()
          .post("/auth/register/start")
          .send({ email: user.email })
          .expect(409);
      });

      it("el panel se entera por /admin/settings", async () => {
        const admin = await createAdmin(app, prisma);
        await http()
          .get("/admin/settings")
          .set("Authorization", auth(admin.token))
          .expect(200)
          .expect((res) => {
            expect(res.body.hardDeleteAccounts).toBe(false);
            expect(res.body.hardDeleteDisabledReason).toMatch(/SUSPENDED/);
          });
      });

      it("suspender sí deja la cuenta afuera sin soltar sus datos", async () => {
        const admin = await createAdmin(app, prisma);
        const user = await registerUser(app);

        await http()
          .patch(`/admin/users/${user.id}/status`)
          .set("Authorization", auth(admin.token))
          .send({ status: "SUSPENDED" })
          .expect(200);

        // No entra ni con la contraseña correcta...
        await http()
          .post("/auth/login")
          .send({ email: user.email, password: TEST_PASSWORD })
          .expect(401);
        // ...ni con el token que ya tenía en la mano.
        await http()
          .get("/users/me")
          .set("Authorization", auth(user.token))
          .expect(401);
        // ...ni registrándose de nuevo con el mismo email.
        await http()
          .post("/auth/register/start")
          .send({ email: user.email })
          .expect(409);
      });
    });
  });
});
