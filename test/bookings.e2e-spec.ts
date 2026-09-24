import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  AuthedUser,
  createListing,
  createVehicle,
  futureDate,
  registerUser,
} from "./helpers/factory";
import {
  authorizeDeposit,
  linkOwnerMercadoPago,
  payBookingFully,
} from "./helpers/payments";
import { EmailService } from "../src/email/email.service";
import type { FakeEmailService } from "./helpers/email.fake";

describe("Bookings", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  /** Owner with an ACTIVE listing + a separate renter. */
  async function setup(): Promise<{
    owner: AuthedUser;
    renter: AuthedUser;
    listingId: string;
  }> {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    const listing = await createListing(app, owner.token, vehicle.id);
    // Con Mercado Pago el cobro se hace en la cuenta del dueño: sin vincularla
    // no puede aceptar reservas (409 OWNER_PAYMENTS_NOT_LINKED).
    await linkOwnerMercadoPago(app, owner);
    const renter = await registerUser(app);
    return { owner, renter, listingId: listing.id };
  }

  const dates = (offset: number) => ({
    startDate: futureDate(offset),
    endDate: futureDate(offset + 3),
  });

  /** Lleva una reserva hasta la ventana de inspección y devuelve su id. */
  async function bookingEnInspeccion(
    owner: AuthedUser,
    renter: AuthedUser,
    listingId: string,
  ): Promise<string> {
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(5) })
      .expect(201);
    const id = created.body.id;

    const accepted = await http()
      .patch(`/bookings/${id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);

    await payBookingFully(app, id, renter.token);
    await authorizeDeposit(app, id, renter.token);
    await http()
      .patch(`/bookings/${id}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(200);

    const tokens = await http()
      .get(`/bookings/${id}/tokens`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    await http()
      .post(`/bookings/${id}/confirm-pickup`)
      .set("Authorization", auth(owner.token))
      .send({ token: tokens.body.pickupQrToken })
      .expect(201);
    await http()
      .post(`/bookings/${id}/confirm-return`)
      .set("Authorization", auth(renter.token))
      .send({ token: accepted.body.returnQrToken })
      .expect(201);

    return id;
  }

  /**
   * EL CAMINO ENTERO, Y QUIÉN TIENE CADA CÓDIGO.
   *
   * Los dos códigos de un solo uso no se entregan juntos ni a la misma
   * persona: quien alquila ve el de RETIRO (se lo muestra al dueño al buscar
   * el auto) y el dueño ve el de DEVOLUCIÓN (se lo muestra a quien alquila al
   * recibirlo). Cada uno lo confirma la otra parte, que es lo que hace que un
   * retiro o una devolución necesiten a las dos personas presentes.
   *
   * Antes los dos códigos venían en la respuesta de la reserva, así que quien
   * alquila podía confirmar la devolución solo —soltando el depósito y
   * cobrándole al dueño— sin haber devuelto nada.
   */
  it("runs the full lifecycle: request → accept → pay → ready → pickup → return → INSPECTION", async () => {
    const { owner, renter, listingId } = await setup();

    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(5) })
      .expect(201);
    expect(created.body.status).toBe("REQUESTED");
    const id = created.body.id;

    const accepted = await http()
      .patch(`/bookings/${id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    expect(accepted.body.status).toBe("ACCEPTED");
    // El dueño se lleva SOLO el código de devolución, y ningún dato interno.
    expect(accepted.body.returnQrToken).toEqual(expect.any(String));
    expect(accepted.body.pickupQrToken).toBeUndefined();
    expect(accepted.body).not.toHaveProperty("pickupTokenHash");
    expect(accepted.body).not.toHaveProperty("returnTokenPreview");
    const returnToken = accepted.body.returnQrToken;

    await payBookingFully(app, id, renter.token);
    await authorizeDeposit(app, id, renter.token);

    const ready = await http()
      .patch(`/bookings/${id}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    expect(ready.body.status).toBe("READY_FOR_PICKUP");

    // Recién con el auto listo, quien alquila puede ver su código de retiro.
    const tokens = await http()
      .get(`/bookings/${id}/tokens`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(tokens.body.pickupQrToken).toEqual(expect.any(String));
    expect(tokens.body.returnQrToken).toBeUndefined();

    const pickedUp = await http()
      .post(`/bookings/${id}/confirm-pickup`)
      .set("Authorization", auth(owner.token))
      .send({ token: tokens.body.pickupQrToken })
      .expect(201);
    expect(pickedUp.body.status).toBe("IN_PROGRESS");

    // Devolver NO cierra la reserva: abre la ventana de inspección de 48
    // horas, que es el plazo que tiene el dueño para reportar un daño.
    const returned = await http()
      .post(`/bookings/${id}/confirm-return`)
      .set("Authorization", auth(renter.token))
      .send({ token: returnToken })
      .expect(201);
    expect(returned.body.status).toBe("INSPECTION");
    expect(returned.body.inspectionEndsAt).toEqual(expect.any(String));

    const horas =
      (new Date(returned.body.inspectionEndsAt).getTime() - Date.now()) /
      3_600_000;
    expect(horas).toBeGreaterThan(47);
    expect(horas).toBeLessThan(49);
  });

  /**
   * Cerrada la ventana sin reclamo, la reserva se liquida: se suelta el
   * depósito y se le paga al dueño. Lo puede pedir cualquiera de las dos
   * partes, y pedirlo dos veces no paga dos veces.
   */
  it("liquida la reserva cuando se cierra la ventana sin reclamos", async () => {
    const { owner, renter, listingId } = await setup();
    const id = await bookingEnInspeccion(owner, renter, listingId);

    // Antes de que venza no se liquida, y se dice por qué: el front tiene que
    // poder mostrar "faltan X horas" en vez de un error pelado.
    const temprano = await http()
      .post(`/bookings/${id}/settle`)
      .set("Authorization", auth(owner.token))
      .expect(409);
    expect(temprano.body.code).toBe("INSPECTION_WINDOW_OPEN");

    await prisma.booking.update({
      where: { id },
      data: { inspectionEndsAt: new Date(Date.now() - 60_000) },
    });

    const liquidada = await http()
      .post(`/bookings/${id}/settle`)
      .set("Authorization", auth(renter.token))
      .expect(201);
    expect(liquidada.body.status).toBe("COMPLETED");
    expect(liquidada.body.settledAt).toEqual(expect.any(String));

    // Pedirla de nuevo no vuelve a mover plata: la liquidación es idempotente
    // porque el trabajo programado y una persona pueden pedirla a la vez.
    const repetida = await http()
      .post(`/bookings/${id}/settle`)
      .set("Authorization", auth(owner.token))
      .expect(201);
    expect(repetida.body.settledAt).toBe(liquidada.body.settledAt);
  });

  it("cannot mark ready for pickup before payment is confirmed", async () => {
    const { owner, renter, listingId } = await setup();
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(30) })
      .expect(201);
    await http()
      .patch(`/bookings/${created.body.id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    // El cobro sigue pendiente: entregar el auto ahora sería entregarlo gratis.
    const res = await http()
      .patch(`/bookings/${created.body.id}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(409);
    expect(res.body.code).toBe("CHECKOUT_NOT_PAID");
  });

  it("forbids booking your own listing", async () => {
    const { owner, listingId } = await setup();
    await http()
      .post("/bookings")
      .set("Authorization", auth(owner.token))
      .send({ listingId, ...dates(5) })
      .expect(403);
  });

  it("rejects invalid date ranges", async () => {
    const { renter, listingId } = await setup();
    // Start date in the past.
    await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({
        listingId,
        startDate: new Date(Date.now() - 86_400_000).toISOString(),
        endDate: futureDate(3),
      })
      .expect(400);
    // End before start.
    await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, startDate: futureDate(5), endDate: futureDate(4) })
      .expect(400);
  });

  it("prevents a second booking that overlaps an accepted one", async () => {
    const { owner, renter, listingId } = await setup();
    const range = dates(8);
    const first = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...range })
      .expect(201);
    await http()
      .patch(`/bookings/${first.body.id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);

    const renter2 = await registerUser(app);
    await http()
      .post("/bookings")
      .set("Authorization", auth(renter2.token))
      .send({ listingId, ...range })
      .expect(400);
  });

  it("enforces participant and owner-only guards", async () => {
    const { renter, listingId } = await setup();
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(12) })
      .expect(201);
    const id = created.body.id;
    const stranger = await registerUser(app);

    await http()
      .get(`/bookings/${id}`)
      .set("Authorization", auth(stranger.token))
      .expect(403);
    await http()
      .patch(`/bookings/${id}/accept`)
      .set("Authorization", auth(renter.token))
      .expect(403);
  });

  it("rejects an invalid pickup token", async () => {
    const { owner, renter, listingId } = await setup();
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(15) })
      .expect(201);
    const id = created.body.id;
    await http()
      .patch(`/bookings/${id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    await payBookingFully(app, id, renter.token);
    await authorizeDeposit(app, id, renter.token);
    await http()
      .patch(`/bookings/${id}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    await http()
      .post(`/bookings/${id}/confirm-pickup`)
      .set("Authorization", auth(owner.token))
      .send({ token: "z".repeat(48) })
      .expect(403);
  });

  it("owner can reject a requested booking", async () => {
    const { owner, renter, listingId } = await setup();
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(18) })
      .expect(201);
    const rejected = await http()
      .patch(`/bookings/${created.body.id}/reject`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    expect(rejected.body.status).toBe("REJECTED");
  });

  it("cancels a paid booking and shows it under /bookings/me", async () => {
    const { owner, renter, listingId } = await setup();
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({ listingId, ...dates(21) })
      .expect(201);
    const id = created.body.id;
    await http()
      .patch(`/bookings/${id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    await payBookingFully(app, id, renter.token);
    await authorizeDeposit(app, id, renter.token);
    const cancelled = await http()
      .patch(`/bookings/${id}/cancel`)
      .set("Authorization", auth(renter.token))
      .send({ reason: "Changed plans" })
      .expect(200);
    expect(cancelled.body.status).toBe("CANCELLED_BY_RENTER");

    const mine = await http()
      .get("/bookings/me")
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(mine.body.length).toBeGreaterThanOrEqual(1);
  });
  /**
   * LOS AVISOS POR MAIL, POR HTTP
   *
   * La lógica de a quién se le avisa ya está probada aparte. Lo que se comprueba
   * acá es que los avisos estén ENGANCHADOS al circuito real: safeNotify se traga
   * cualquier error en silencio a propósito —para que un mail caído no tire abajo
   * una reserva—, y ese silencio también taparía un envío que alguien borró sin
   * darse cuenta.
   */
  describe("avisos por mail del circuito de reserva", () => {
    const mails = () => app.get(EmailService) as unknown as FakeEmailService;

    it("pedir una reserva avisa al dueño Y al inquilino", async () => {
      const { owner, renter, listingId } = await setup();

      await http()
        .post("/bookings")
        .set("Authorization", auth(renter.token))
        .send({
          listingId,
          startDate: futureDate(10),
          endDate: futureDate(12),
        })
        .expect(201);

      expect(mails().huboAviso("bookingRequestedToOwner", owner.email)).toBe(
        true,
      );
      // El que faltaba: quien reserva no recibía nada.
      expect(mails().huboAviso("bookingRequestedToRenter", renter.email)).toBe(
        true,
      );
    });

    it("aceptar avisa al inquilino, y cancelar avisa a los dos", async () => {
      const { owner, renter, listingId } = await setup();

      const creada = await http()
        .post("/bookings")
        .set("Authorization", auth(renter.token))
        .send({
          listingId,
          startDate: futureDate(20),
          endDate: futureDate(22),
        })
        .expect(201);
      const bookingId = creada.body.id as string;

      await http()
        .patch(`/bookings/${bookingId}/accept`)
        .set("Authorization", auth(owner.token))
        .expect(200);
      expect(mails().huboAviso("bookingAcceptedToRenter", renter.email)).toBe(
        true,
      );

      await http()
        .patch(`/bookings/${bookingId}/cancel`)
        .set("Authorization", auth(renter.token))
        .send({ reason: "Me surgió un viaje" })
        .expect(200);

      // Las dos partes se enteran de la cancelación.
      expect(mails().huboAviso("bookingCancelled", renter.email)).toBe(true);
      expect(mails().huboAviso("bookingCancelled", owner.email)).toBe(true);

      // Y el motivo viaja en el mail, no se pierde en la base.
      const aviso = mails()
        .avisos(owner.email)
        .find((a) => a.tipo === "bookingCancelled");
      expect((aviso?.params as { reason?: string })?.reason).toBe(
        "Me surgió un viaje",
      );
    });

    it("rechazar avisa al inquilino", async () => {
      const { owner, renter, listingId } = await setup();

      const creada = await http()
        .post("/bookings")
        .set("Authorization", auth(renter.token))
        .send({
          listingId,
          startDate: futureDate(30),
          endDate: futureDate(32),
        })
        .expect(201);

      await http()
        .patch(`/bookings/${creada.body.id as string}/reject`)
        .set("Authorization", auth(owner.token))
        .expect(200);

      expect(mails().huboAviso("bookingRejectedToRenter", renter.email)).toBe(
        true,
      );
    });
  });
});
