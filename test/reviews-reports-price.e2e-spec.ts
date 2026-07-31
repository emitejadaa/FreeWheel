import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import { FakeEmailService } from "./helpers/email.fake";
import {
  bearer,
  createAdmin,
  createListing,
  createVehicle,
  futureDate,
  registerUser,
} from "./helpers/factory";

/**
 * Reseñas, reportes y cambio de precio: las tres funciones que antes no
 * existían del lado del servidor (las reseñas eran de ejemplo, los reportes se
 * guardaban en el navegador de quien reportaba y el precio se cambiaba con un
 * PATCH cualquiera).
 */
describe("Reviews, reports and price change", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let email: FakeEmailService;

  beforeAll(async () => {
    ({ app, prisma, email } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  const http = () => request(app.getHttpServer());

  /** Reserva llevada a mano al estado final: completada y pagada. */
  async function completedBooking() {
    const owner = await registerUser(app);
    const renter = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    const listing = await createListing(app, owner.token, vehicle.id);

    const booking = await prisma.booking.create({
      data: {
        listingId: listing.id,
        vehicleId: vehicle.id,
        ownerId: owner.id,
        renterId: renter.id,
        startDate: new Date(futureDate(5)),
        endDate: new Date(futureDate(8)),
        status: BookingStatus.COMPLETED,
        paymentStatus: PaymentStatus.FULLY_PAID,
        pricePerDaySnapshot: 1000,
        totalPriceSnapshot: 3000,
      },
    });

    return { owner, renter, listing, booking };
  }

  describe("reviews", () => {
    it("lets the renter review a completed and paid booking, and stores the real average", async () => {
      const { renter, listing, booking } = await completedBooking();

      await http()
        .post(`/bookings/${booking.id}/reviews`)
        .set("Authorization", bearer(renter.token))
        .send({ rating: 4, comment: "Todo perfecto, el auto impecable." })
        .expect(201);

      const reviews = await http()
        .get(`/listings/${listing.id}/reviews`)
        .expect(200);
      expect(reviews.body).toHaveLength(1);
      expect(reviews.body[0].rating).toBe(4);

      // El promedio queda guardado en la publicación, no calculado al vuelo.
      const stored = await prisma.listing.findUnique({
        where: { id: listing.id },
      });
      expect(stored?.ratingAverage).toBe(4);
      expect(stored?.ratingCount).toBe(1);
    });

    it("averages several reviews with one decimal", async () => {
      const { listing, owner } = await completedBooking();
      const vehicle = await createVehicle(app, owner.token, { brand: "Fiat" });
      void vehicle;

      // Dos reservas más sobre la misma publicación, cada una con su inquilino.
      for (const rating of [5, 4]) {
        const renter = await registerUser(app);
        const booking = await prisma.booking.create({
          data: {
            listingId: listing.id,
            vehicleId: listing.vehicleId as string,
            ownerId: owner.id,
            renterId: renter.id,
            startDate: new Date(futureDate(20)),
            endDate: new Date(futureDate(22)),
            status: BookingStatus.COMPLETED,
            paymentStatus: PaymentStatus.FULLY_PAID,
            pricePerDaySnapshot: 1000,
            totalPriceSnapshot: 2000,
          },
        });
        await http()
          .post(`/bookings/${booking.id}/reviews`)
          .set("Authorization", bearer(renter.token))
          .send({ rating })
          .expect(201);
      }

      const renter3 = await registerUser(app);
      const third = await prisma.booking.create({
        data: {
          listingId: listing.id,
          vehicleId: listing.vehicleId as string,
          ownerId: owner.id,
          renterId: renter3.id,
          startDate: new Date(futureDate(30)),
          endDate: new Date(futureDate(32)),
          status: BookingStatus.COMPLETED,
          paymentStatus: PaymentStatus.FULLY_PAID,
          pricePerDaySnapshot: 1000,
          totalPriceSnapshot: 2000,
        },
      });
      await http()
        .post(`/bookings/${third.id}/reviews`)
        .set("Authorization", bearer(renter3.token))
        .send({ rating: 4 })
        .expect(201);

      const stored = await prisma.listing.findUnique({
        where: { id: listing.id },
      });
      // (5 + 4 + 4) / 3 = 4.333... → 4.3
      expect(stored?.ratingAverage).toBe(4.3);
      expect(stored?.ratingCount).toBe(3);
    });

    it("refuses a review when the booking is not completed", async () => {
      const { renter, booking } = await completedBooking();
      await prisma.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.ACCEPTED },
      });

      await http()
        .post(`/bookings/${booking.id}/reviews`)
        .set("Authorization", bearer(renter.token))
        .send({ rating: 5 })
        .expect(400);
    });

    it("refuses a review when the booking was not paid", async () => {
      const { renter, booking } = await completedBooking();
      await prisma.booking.update({
        where: { id: booking.id },
        data: { paymentStatus: PaymentStatus.PENDING },
      });

      await http()
        .post(`/bookings/${booking.id}/reviews`)
        .set("Authorization", bearer(renter.token))
        .send({ rating: 5 })
        .expect(400);
    });

    it("refuses a second review from the same person, and one from a stranger", async () => {
      const { renter, booking } = await completedBooking();
      const stranger = await registerUser(app);

      await http()
        .post(`/bookings/${booking.id}/reviews`)
        .set("Authorization", bearer(renter.token))
        .send({ rating: 5 })
        .expect(201);

      await http()
        .post(`/bookings/${booking.id}/reviews`)
        .set("Authorization", bearer(renter.token))
        .send({ rating: 1 })
        .expect(400);

      await http()
        .post(`/bookings/${booking.id}/reviews`)
        .set("Authorization", bearer(stranger.token))
        .send({ rating: 1 })
        .expect(403);
    });

    it("keeps the owner's review off the listing average (it is about the person)", async () => {
      const { owner, renter, listing, booking } = await completedBooking();

      await http()
        .post(`/bookings/${booking.id}/reviews`)
        .set("Authorization", bearer(renter.token))
        .send({ rating: 5 })
        .expect(201);
      await http()
        .post(`/bookings/${booking.id}/reviews`)
        .set("Authorization", bearer(owner.token))
        .send({ rating: 2, comment: "Devolvió el auto sucio." })
        .expect(201);

      // La publicación queda con la puntuación de quien alquiló, sola.
      const stored = await prisma.listing.findUnique({
        where: { id: listing.id },
      });
      expect(stored?.ratingAverage).toBe(5);
      expect(stored?.ratingCount).toBe(1);

      // Y la persona que alquiló acumula la del dueño en su perfil.
      const renterRow = await prisma.user.findUnique({
        where: { id: renter.id },
      });
      expect(renterRow?.ratingAverage).toBe(2);
    });

    it("rejects a rating outside 1..5", async () => {
      const { renter, booking } = await completedBooking();
      for (const rating of [0, 6, 4.5]) {
        await http()
          .post(`/bookings/${booking.id}/reviews`)
          .set("Authorization", bearer(renter.token))
          .send({ rating })
          .expect(400);
      }
    });
  });

  describe("reports", () => {
    it("stores the report and shows it to an admin, who can pause the listing", async () => {
      const owner = await registerUser(app);
      const reporter = await registerUser(app);
      const admin = await createAdmin(app, prisma);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      const created = await http()
        .post("/reports")
        .set("Authorization", bearer(reporter.token))
        .send({
          targetType: "LISTING",
          listingId: listing.id,
          reason: "Información falsa en la publicación",
          details:
            "Las fotos son de otro auto y el año no coincide con el del título.",
          evidenceUrls: ["https://res.cloudinary.com/demo/image/upload/prueba1.jpg"],
        })
        .expect(201);
      expect(created.body.status).toBe("OPEN");

      // Le llega al admin.
      const inbox = await http()
        .get("/admin/reports")
        .set("Authorization", bearer(admin.token))
        .expect(200);
      expect(inbox.body).toHaveLength(1);
      expect(inbox.body[0].listing.id).toBe(listing.id);

      // Y el admin puede actuar.
      await http()
        .patch(`/admin/reports/${created.body.id}/resolve`)
        .set("Authorization", bearer(admin.token))
        .send({ action: "PAUSE_LISTING", note: "Fotos que no corresponden" })
        .expect(200);

      const paused = await prisma.listing.findUnique({
        where: { id: listing.id },
      });
      expect(paused?.status).toBe("PAUSED");

      const resolved = await prisma.report.findUnique({
        where: { id: created.body.id },
      });
      expect(resolved?.status).toBe("ACTION_TAKEN");
      expect(resolved?.resolvedById).toBe(admin.id);
    });

    it("keeps the admin inbox closed to everyone else", async () => {
      const someone = await registerUser(app);
      await http()
        .get("/admin/reports")
        .set("Authorization", bearer(someone.token))
        .expect(403);
    });

    it("requires a real explanation (min length) and a target", async () => {
      const reporter = await registerUser(app);

      await http()
        .post("/reports")
        .set("Authorization", bearer(reporter.token))
        .send({
          targetType: "LISTING",
          reason: "Falsa",
          details: "corto",
          evidenceUrls: ["https://res.cloudinary.com/demo/image/upload/x.jpg"],
        })
        .expect(400);
    });

    it("refuses a report with no evidence attached", async () => {
      const owner = await registerUser(app);
      const reporter = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      // Sin pruebas es la palabra de uno contra la del otro: el admin no tiene
      // con qué decidir si pausar la publicación.
      const res = await http()
        .post("/reports")
        .set("Authorization", bearer(reporter.token))
        .send({
          targetType: "LISTING",
          listingId: listing.id,
          reason: "Información falsa en la publicación",
          details: "Las fotos no corresponden al auto que figura en el título.",
          evidenceUrls: [],
        })
        .expect(400);
      expect(String(res.body.message)).toContain("al menos una foto");

      // Y tampoco si el campo no viene.
      await http()
        .post("/reports")
        .set("Authorization", bearer(reporter.token))
        .send({
          targetType: "LISTING",
          listingId: listing.id,
          reason: "Información falsa en la publicación",
          details: "Las fotos no corresponden al auto que figura en el título.",
        })
        .expect(400);
    });

    it("stores the evidence and shows it to the admin", async () => {
      const owner = await registerUser(app);
      const reporter = await registerUser(app);
      const admin = await createAdmin(app, prisma);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      const pruebas = [
        "https://res.cloudinary.com/demo/image/upload/prueba1.jpg",
        "https://res.cloudinary.com/demo/image/upload/prueba2.jpg",
      ];

      const created = await http()
        .post("/reports")
        .set("Authorization", bearer(reporter.token))
        .send({
          targetType: "LISTING",
          listingId: listing.id,
          reason: "Vehículo en mal estado no declarado",
          details: "El parabrisas estaba rajado y no figuraba en la publicación.",
          evidenceUrls: pruebas,
        })
        .expect(201);
      expect(created.body.evidenceUrls).toEqual(pruebas);

      // El admin las recibe: son lo que tiene que mirar antes de actuar.
      const inbox = await http()
        .get("/admin/reports")
        .set("Authorization", bearer(admin.token))
        .expect(200);
      expect(inbox.body[0].evidenceUrls).toEqual(pruebas);
    });

    it("rejects more than 5 files and anything that is not a URL", async () => {
      const owner = await registerUser(app);
      const reporter = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      const base = {
        targetType: "LISTING",
        listingId: listing.id,
        reason: "Intento de estafa o fraude",
        details: "Me pidió transferir por fuera de la plataforma para reservar.",
      };

      await http()
        .post("/reports")
        .set("Authorization", bearer(reporter.token))
        .send({
          ...base,
          evidenceUrls: Array.from(
            { length: 6 },
            (_, i) => `https://res.cloudinary.com/demo/image/upload/p${i}.jpg`,
          ),
        })
        .expect(400);

      await http()
        .post("/reports")
        .set("Authorization", bearer(reporter.token))
        .send({ ...base, evidenceUrls: ["no-es-una-url"] })
        .expect(400);
    });

    it("refuses to resolve the same report twice", async () => {
      const owner = await registerUser(app);
      const reporter = await registerUser(app);
      const admin = await createAdmin(app, prisma);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      const created = await http()
        .post("/reports")
        .set("Authorization", bearer(reporter.token))
        .send({
          targetType: "LISTING",
          listingId: listing.id,
          reason: "Vehículo en mal estado no declarado",
          details: "El auto tenía el parabrisas roto y no estaba informado.",
          evidenceUrls: ["https://res.cloudinary.com/demo/image/upload/roto.jpg"],
        })
        .expect(201);

      await http()
        .patch(`/admin/reports/${created.body.id}/resolve`)
        .set("Authorization", bearer(admin.token))
        .send({ action: "DISMISS" })
        .expect(200);

      await http()
        .patch(`/admin/reports/${created.body.id}/resolve`)
        .set("Authorization", bearer(admin.token))
        .send({ action: "DISMISS" })
        .expect(400);
    });
  });

  describe("price change", () => {
    it("only applies the new price after the emailed code is confirmed", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id, {
        pricePerDay: 1000,
      });

      await http()
        .post(`/listings/${listing.id}/price-change`)
        .set("Authorization", bearer(owner.token))
        .send({ pricePerDay: 2500 })
        .expect(201);

      // Todavía no cambió: el precio viejo sigue siendo el que se cobra.
      let stored = await prisma.listing.findUnique({
        where: { id: listing.id },
      });
      expect(stored?.pricePerDay).toBe(1000);
      expect(stored?.pendingPricePerDay).toBe(2500);

      const code = email.lastPriceChangeCode(owner.email);
      expect(code).toMatch(/^\d{6}$/);

      await http()
        .post(`/listings/${listing.id}/price-change/confirm`)
        .set("Authorization", bearer(owner.token))
        .send({ code })
        .expect(201);

      stored = await prisma.listing.findUnique({ where: { id: listing.id } });
      expect(stored?.pricePerDay).toBe(2500);
      expect(stored?.pendingPricePerDay).toBeNull();
      expect(stored?.priceUpdatedAt).toBeTruthy();
    });

    it("rejects a wrong code and keeps the old price", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id, {
        pricePerDay: 1000,
      });

      await http()
        .post(`/listings/${listing.id}/price-change`)
        .set("Authorization", bearer(owner.token))
        .send({ pricePerDay: 9000 })
        .expect(201);

      await http()
        .post(`/listings/${listing.id}/price-change/confirm`)
        .set("Authorization", bearer(owner.token))
        .send({ code: "000000" })
        .expect(400);

      const stored = await prisma.listing.findUnique({
        where: { id: listing.id },
      });
      expect(stored?.pricePerDay).toBe(1000);
    });

    it("blocks the change while a booking is in course", async () => {
      const { owner, listing } = await completedBooking();
      await prisma.booking.updateMany({
        where: { listingId: listing.id },
        data: { status: BookingStatus.ACCEPTED },
      });

      const res = await http()
        .post(`/listings/${listing.id}/price-change`)
        .set("Authorization", bearer(owner.token))
        .send({ pricePerDay: 4000 })
        .expect(400);
      expect(String(res.body.message)).toContain("reservas en curso");
    });

    it("applies the waiting time between two changes", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id, {
        pricePerDay: 1000,
      });

      // Se simula un cambio recién hecho.
      await prisma.listing.update({
        where: { id: listing.id },
        data: { priceUpdatedAt: new Date() },
      });

      const res = await http()
        .post(`/listings/${listing.id}/price-change`)
        .set("Authorization", bearer(owner.token))
        .send({ pricePerDay: 1500 })
        .expect(400);
      expect(String(res.body.message)).toContain("una vez cada");
    });

    it("does not let someone else touch the price", async () => {
      const owner = await registerUser(app);
      const other = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      await http()
        .post(`/listings/${listing.id}/price-change`)
        .set("Authorization", bearer(other.token))
        .send({ pricePerDay: 1 })
        .expect(403);
    });

    it("reports whether the price can be changed right now", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id, {
        pricePerDay: 1000,
      });

      const status = await http()
        .get(`/listings/${listing.id}/price-change`)
        .set("Authorization", bearer(owner.token))
        .expect(200);

      expect(status.body).toMatchObject({
        pricePerDay: 1000,
        pendingPricePerDay: null,
        canChange: true,
        blockedByBookings: false,
      });
    });
  });
});
