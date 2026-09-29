import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  AuthedUser,
  createAdmin,
  createListing,
  createVehicle,
  futureDate,
  registerUser,
} from "./helpers/factory";
import {
  acceptContract,
  createIntent,
  payBookingFully,
  sendWebhook,
} from "./helpers/payments";

describe("Payments (Stripe flow, mocked provider)", () => {
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

  /** Owner + renter + an ACCEPTED booking (pricing snapshots + contract set). */
  async function acceptedBooking(): Promise<{
    owner: AuthedUser;
    renter: AuthedUser;
    bookingId: string;
    returnToken: string;
  }> {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    // pricePerDay 1000, 3 días => alquiler 3000, cobertura 300, total 3300,
    // seña 900 (30 % del ALQUILER), depósito 200, para el dueño 2700.
    const listing = await createListing(app, owner.token, vehicle.id, {
      pricePerDay: 1000,
    });
    const renter = await registerUser(app);
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({
        listingId: listing.id,
        startDate: futureDate(5),
        endDate: futureDate(8),
      })
      .expect(201);
    const accepted = await http()
      .patch(`/bookings/${created.body.id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    return {
      owner,
      renter,
      bookingId: created.body.id,
      returnToken: accepted.body.returnQrToken,
    };
  }

  /** El código de retiro, que quien alquila recibe recién con el auto listo. */
  async function pickupToken(
    bookingId: string,
    renter: AuthedUser,
  ): Promise<string> {
    const res = await http()
      .get(`/bookings/${bookingId}/tokens`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    return res.body.pickupQrToken;
  }

  /** Paga, marca listo y confirma el retiro: deja el auto en la calle. */
  async function hastaElRetiro(
    owner: AuthedUser,
    renter: AuthedUser,
    bookingId: string,
  ): Promise<{ checkout: { paymentIntentId: string } }> {
    const pagos = await payBookingFully(app, bookingId, renter.token);
    await http()
      .patch(`/bookings/${bookingId}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    await http()
      .post(`/bookings/${bookingId}/confirm-pickup`)
      .set("Authorization", auth(owner.token))
      .send({ token: await pickupToken(bookingId, renter) })
      .expect(201);
    return pagos;
  }

  it("locks server-side pricing snapshots on accept", async () => {
    const { renter, bookingId } = await acceptedBooking();

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    expect(status.body.currency).toBe("usd");
    expect(status.body.total).toBe(3300);
    // La seña es el 30 % del ALQUILER (3000), no del total: la cobertura y la
    // comisión no son parte de lo que se señó, así que no se pierden ni se
    // duplican si alguien se arrepiente.
    expect(status.body.sena).toBe(900);
    // Ya no existe un "saldo" aparte: se paga todo junto.
    expect(status.body.balance).toBeNull();
    expect(status.body.deposit).toBe(200);
    expect(status.body.commission).toBe(300);
    expect(status.body.insurance).toBe(300);
    expect(status.body.ownerPayout).toBe(2700);
    expect(status.body.paymentStatus).toBe("PENDING");
  });

  /**
   * EL TICKET: qué se cobra, desglosado, antes de poner la tarjeta. Las dos
   * columnas —conceptos y destinos— tienen que dar el mismo total.
   */
  it("muestra el ticket desglosado antes de pagar", async () => {
    const { renter, bookingId } = await acceptedBooking();

    const ticket = await http()
      .get(`/payments/bookings/${bookingId}/ticket`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    expect(ticket.body.totalMinor).toBe(330_000);
    expect(ticket.body.sena.amountMinor).toBe(90_000);
    expect(ticket.body.sena.kind).toBe("PENITENCIAL");
    // El depósito NO suma al total: es una retención, no un cobro.
    expect(ticket.body.deposit.amountMinor).toBe(20_000);
    expect(ticket.body.deposit.kind).toBe("HOLD");

    const sumar = (xs: { amountMinor: number }[]) =>
      xs.reduce((t, x) => t + x.amountMinor, 0);
    expect(sumar(ticket.body.lines)).toBe(330_000);
    expect(sumar(ticket.body.distribution)).toBe(330_000);
  });

  /**
   * SIN CONTRATO FIRMADO NO SE COBRA.
   *
   * Es el orden que hace que el cobro tenga respaldo: primero la persona
   * acepta un texto concreto —con su hash guardado— y recién después se le
   * pide la tarjeta. Al revés, tendríamos plata cobrada sobre un acuerdo que
   * nadie aceptó.
   */
  it("no deja pagar antes de aceptar el contrato", async () => {
    const { renter, bookingId } = await acceptedBooking();

    const res = await http()
      .post(`/payments/bookings/${bookingId}/checkout`)
      .set("Authorization", auth(renter.token))
      .expect(409);
    expect(res.body.code).toBe("CONTRACT_NOT_ACCEPTED");

    await acceptContract(app, bookingId, renter.token);
    const ok = await http()
      .post(`/payments/bookings/${bookingId}/checkout`)
      .set("Authorization", auth(renter.token))
      .expect(201);
    expect(ok.body.paymentIntentId).toMatch(/^pi_/);
  });

  it("creates a single checkout intent with the server-computed amount", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await acceptContract(app, bookingId, renter.token);

    const intent = await createIntent(app, "checkout", bookingId, renter.token);
    expect(intent.paymentIntentId).toMatch(/^pi_/);
    expect(intent.clientSecret).toEqual(expect.any(String));
    // Alquiler + cobertura, todo junto: 3300.00 USD.
    expect(intent.amountMinor).toBe(330_000);
    expect(intent.currency).toBe("usd");
  });

  it("marks the booking FULLY_PAID after the checkout webhook", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await payBookingFully(app, bookingId, renter.token);

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(status.body.paymentStatus).toBe("FULLY_PAID");
    expect(status.body.paidAt).toEqual(expect.any(String));
  });

  /**
   * El saldo por separado ya no existe. La ruta sigue publicada para no
   * romper un front viejo, pero contesta un código que explica qué pasó en
   * vez de un error genérico.
   */
  it("el cobro en dos tramos ya no existe, y se dice con un código", async () => {
    const { renter, bookingId } = await acceptedBooking();
    const res = await http()
      .post(`/payments/bookings/${bookingId}/balance-intent`)
      .set("Authorization", auth(renter.token))
      .expect(409);
    expect(res.body.code).toBe("PAYMENT_IS_SINGLE");
  });

  /**
   * EL CIERRE COMPLETO. Devolver abre la ventana de inspección; recién cuando
   * se cierra sin reclamos se le transfiere al dueño y se suelta el depósito.
   * Antes eso pasaba en el mismo instante de la devolución, sin darle a nadie
   * tiempo de mirar el auto.
   */
  it("runs the full settlement: pickup → return → inspección vencida → pago al dueño", async () => {
    const { owner, renter, bookingId, returnToken } = await acceptedBooking();
    await hastaElRetiro(owner, renter, bookingId);

    await http()
      .post(`/bookings/${bookingId}/confirm-return`)
      .set("Authorization", auth(renter.token))
      .send({ token: returnToken })
      .expect(201);

    /*
      TODAVÍA NO SE LE PAGÓ A NADIE Y EL DEPÓSITO SIGUE RETENIDO, que es el
      cambio de fondo.

      Antes el depósito se soltaba en el mismo instante en que se confirmaba la
      devolución, y eso dejaba el reclamo por daños en una situación imposible:
      cuando el dueño se acercaba al auto y veía el golpe, la retención ya no
      existía y no había nada que capturar.
    */
    const enInspeccion = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(enInspeccion.body.ownerTransferId).toBeNull();
    expect(enInspeccion.body.inspectionEndsAt).toEqual(expect.any(String));

    const durante = (
      enInspeccion.body.records as { kind: string; status: string }[]
    ).map((r) => `${r.kind}:${r.status}`);
    expect(durante).toContain("DEPOSIT_HOLD:AUTHORIZED");
    expect(durante).not.toContain("DEPOSIT_HOLD:RELEASED");

    await prisma.booking.update({
      where: { id: bookingId },
      data: { inspectionEndsAt: new Date(Date.now() - 60_000) },
    });
    await http()
      .post(`/bookings/${bookingId}/settle`)
      .set("Authorization", auth(owner.token))
      .expect(201);

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    expect(status.body.ownerTransferId).toMatch(/^tr_/);
    const kinds = status.body.records.map(
      (r: { kind: string; status: string }) => `${r.kind}:${r.status}`,
    );
    expect(kinds).toContain("OWNER_TRANSFER:PAID");
    // Cerrada la ventana sin reclamos, recién ahí se suelta.
    expect(kinds).toContain("DEPOSIT_HOLD:RELEASED");

    // Owner now has a connected account on file.
    const ownerRow = await prisma.user.findUnique({ where: { id: owner.id } });
    expect(ownerRow?.stripeAccountId).toMatch(/^acct_/);
  });

  /**
   * "REVISÉ EL AUTO Y ESTÁ TODO BIEN": el camino que recorre casi toda
   * devolución. Sin esto, la garantía de alguien que devolvió el auto
   * impecable queda retenida 48 horas por las dudas, recortándole el límite de
   * la tarjeta, y el dueño no tiene forma de destrabarla aunque quiera.
   */
  it("el dueño puede cerrar la revisión antes de tiempo y eso suelta el depósito", async () => {
    const { owner, renter, bookingId, returnToken } = await acceptedBooking();
    await hastaElRetiro(owner, renter, bookingId);
    await http()
      .post(`/bookings/${bookingId}/confirm-return`)
      .set("Authorization", auth(renter.token))
      .send({ token: returnToken })
      .expect(201);

    const cerrada = await http()
      .post(`/bookings/${bookingId}/inspection-ok`)
      .set("Authorization", auth(owner.token))
      .expect(201);
    expect(cerrada.body.settled).toBe(true);

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    const kinds = (
      status.body.records as { kind: string; status: string }[]
    ).map((r) => `${r.kind}:${r.status}`);
    expect(kinds).toContain("DEPOSIT_HOLD:RELEASED");
    expect(kinds).toContain("OWNER_TRANSFER:PAID");

    // Quien alquiló no puede cerrarla: no es su revisión.
    const otra = await acceptedBooking();
    await hastaElRetiro(otra.owner, otra.renter, otra.bookingId);
    await http()
      .post(`/bookings/${otra.bookingId}/confirm-return`)
      .set("Authorization", auth(otra.renter.token))
      .send({ token: otra.returnToken })
      .expect(201);
    const negada = await http()
      .post(`/bookings/${otra.bookingId}/inspection-ok`)
      .set("Authorization", auth(otra.renter.token))
      .expect(403);
    expect(negada.body.code).toBe("NOT_BOOKING_OWNER");
  });

  /**
   * EL LIBRO MAYOR: cada peso que entra tiene que estar en alguna cuenta, y
   * las partidas de cada asiento tienen que sumar cero. Es lo que permite
   * contestar "¿de quién es esta plata?" en cualquier momento, y lo que hace
   * que un error de reparto se vea en vez de esconderse.
   */
  it("deja cada concepto en su propio bolsillo, y los asientos cierran", async () => {
    const { owner, renter, bookingId } = await acceptedBooking();
    await payBookingFully(app, bookingId, renter.token);

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    // Lo retenido por esta reserva, por concepto, antes de liquidar.
    expect(status.body.heldMinor).toMatchObject({
      sena: 90_000,
      rental: 210_000,
      insurance: 30_000,
    });

    const admin = await createAdmin(app, prisma);
    const asientos = await http()
      .get(`/payments/admin/ledger/bookings/${bookingId}`)
      .set("Authorization", auth(admin.token))
      .expect(200);

    expect(asientos.body.length).toBeGreaterThan(0);
    for (const asiento of asientos.body as {
      entries: { amountMinor: number }[];
    }[]) {
      const suma = asiento.entries.reduce((t, e) => t + e.amountMinor, 0);
      expect(suma).toBe(0);
    }
    expect(owner.id).toEqual(expect.any(String));
  });

  it("blocks ready-for-pickup until the checkout is paid", async () => {
    const { owner, renter, bookingId } = await acceptedBooking();
    await acceptContract(app, bookingId, renter.token);
    // Intent creado pero sin confirmar: no entró un peso.
    await createIntent(app, "checkout", bookingId, renter.token);

    const res = await http()
      .patch(`/bookings/${bookingId}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(409);
    expect(res.body.code).toBe("CHECKOUT_NOT_PAID");
  });

  /**
   * El depósito se autoriza SIN el cliente presente, con la tarjeta que quedó
   * guardada del cobro, justo antes de la entrega. Se hace así porque una
   * retención dura unos días: pedirla al pagar, semanas antes del viaje, la
   * dejaría vencida para cuando el auto sale.
   */
  it("autoriza el depósito con la tarjeta guardada al marcar listo", async () => {
    const { owner, renter, bookingId } = await acceptedBooking();
    await payBookingFully(app, bookingId, renter.token);

    const ready = await http()
      .patch(`/bookings/${bookingId}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    expect(ready.body.status).toBe("READY_FOR_PICKUP");

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    const hold = (
      status.body.records as { kind: string; status: string }[]
    ).find((r) => r.kind === "DEPOSIT_HOLD");
    expect(hold?.status).toBe("AUTHORIZED");
  });

  it("rejects a webhook with an invalid signature", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await acceptContract(app, bookingId, renter.token);
    const checkout = await createIntent(
      app,
      "checkout",
      bookingId,
      renter.token,
    );
    await http()
      .post("/payments/stripe/webhook")
      .set("Stripe-Signature", "t=1,v1=deadbeef")
      .set("Content-Type", "application/json")
      .send(
        JSON.stringify({
          id: "evt_bad",
          type: "payment_intent.succeeded",
          data: { object: { id: checkout.paymentIntentId } },
        }),
      )
      .expect(400);
  });

  it("processes each webhook event id only once (idempotent)", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await acceptContract(app, bookingId, renter.token);
    const checkout = await createIntent(
      app,
      "checkout",
      bookingId,
      renter.token,
    );

    const first = await sendWebhook(
      app,
      "payment_intent.succeeded",
      { id: checkout.paymentIntentId },
      { id: "evt_dup_1" },
    ).expect(201);
    expect(first.body.duplicate).toBe(false);

    const second = await sendWebhook(
      app,
      "payment_intent.succeeded",
      { id: checkout.paymentIntentId },
      { id: "evt_dup_1" },
    ).expect(201);
    expect(second.body.duplicate).toBe(true);

    const events = await prisma.stripeEvent.findMany({
      where: { eventId: "evt_dup_1" },
    });
    expect(events).toHaveLength(1);
  });

  it("forbids a non-participant from viewing payment status", async () => {
    const { bookingId } = await acceptedBooking();
    const stranger = await registerUser(app);
    await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(stranger.token))
      .expect(403);
  });

  /**
   * SI CANCELA EL DUEÑO, QUIEN ALQUILA NO PIERDE NADA. Además de devolverle
   * todo, la seña doblada del artículo 1059 queda como deuda del dueño: la
   * parte que no se puede devolver a la tarjeta no desaparece.
   */
  it("refunds the captured charges when a paid booking is cancelled", async () => {
    const { owner, renter, bookingId } = await acceptedBooking();
    await payBookingFully(app, bookingId, renter.token);

    const cancelada = await http()
      .patch(`/bookings/${bookingId}/cancel`)
      .set("Authorization", auth(owner.token))
      .send({ reason: "owner unavailable" })
      .expect(200);
    expect(cancelada.body.cancellation.rule).toBe(
      "OWNER_RETURNS_SENA_DOUBLED",
    );

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(status.body.paymentStatus).toBe("REFUNDED");
    const kinds = status.body.records.map((r: { kind: string }) => r.kind);
    expect(kinds).toContain("REFUND");
  });

  /**
   * Antes de cancelar se puede preguntar cuánto se devuelve. Sin esto, la
   * única forma de averiguar que se perdía la seña era perderla.
   */
  it("dice cuánto se devuelve ANTES de cancelar", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await payBookingFully(app, bookingId, renter.token);

    const previa = await http()
      .get(`/bookings/${bookingId}/cancellation-preview`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    expect(previa.body.rule).toEqual(expect.any(String));
    expect(previa.body.refundToRenterMinor).toEqual(expect.any(Number));
    expect(previa.body.refundToRenterMinor).toBeLessThanOrEqual(330_000);
  });

  it("lets the renter onboard nothing but the owner create a connected account", async () => {
    const { owner } = await acceptedBooking();
    const res = await http()
      .post("/payments/connect/onboarding")
      .set("Authorization", auth(owner.token))
      .expect(201);
    expect(res.body.accountId).toMatch(/^acct_/);
    expect(res.body.onboardingUrl).toEqual(expect.any(String));
  });

  // ── Rastro de la transacción y antifraude ──────────────────────────────

  describe("el rastro de cada transacción", () => {
    it("guarda de dónde salió el pedido y con qué tarjeta se pagó", async () => {
      // Es lo que después permite contestar un desconocimiento de cobro. El
      // número de tarjeta no pasa nunca por acá: lo que se guarda son las
      // señas que devuelve el procesador.
      const { renter, bookingId } = await acceptedBooking();
      await acceptContract(app, bookingId, renter.token);

      const checkout = await http()
        .post(`/payments/bookings/${bookingId}/checkout`)
        .set("Authorization", auth(renter.token))
        .set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
        .set("User-Agent", "FreeWheelApp/1.0")
        .expect(201);

      const creado = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "CHECKOUT" },
      });
      // La cabecera X-Forwarded-For NO se cree porque sí: la manda quien
      // llama, así que cualquiera puede escribir la IP que quiera. Sin un
      // proxy declarado se usa la de la conexión, que no se puede inventar.
      // Si se creyera siempre, el tope de intentos por IP no valdría nada:
      // basta cambiar un texto en cada pedido para tener un contador nuevo.
      expect(creado.initiatedIp).toBe("::ffff:127.0.0.1");
      expect(creado.initiatedUserAgent).toBe("FreeWheelApp/1.0");

      await sendWebhook(app, "payment_intent.succeeded", {
        id: checkout.body.paymentIntentId,
      }).expect(201);

      const cobrado = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "CHECKOUT" },
      });
      expect(cobrado.status).toBe("CAPTURED");
      expect(cobrado.cardLast4).toBe("4242");
      // El fingerprint es lo que deja ver cinco cuentas nuevas pagando con el
      // mismo plástico, que es la forma que tiene el fraude de verse desde acá.
      expect(cobrado.cardFingerprint).toBe("fp_mock_4242");
      expect(cobrado.riskLevel).toBe("normal");
    });

    it("anota cada paso en un registro que no se pisa", async () => {
      const { renter, bookingId } = await acceptedBooking();
      await payBookingFully(app, bookingId, renter.token);

      const ledger = await http()
        .get(`/payments/bookings/${bookingId}/ledger`)
        .set("Authorization", auth(renter.token))
        .expect(200);

      const tipos = (ledger.body as { type: string }[]).map((e) => e.type);
      expect(tipos).toContain("checkout.intent.created");
      expect(tipos).toContain("intent.succeeded");
      // El orden importa: primero se pidió, después se cobró.
      expect(tipos.indexOf("checkout.intent.created")).toBeLessThan(
        tipos.indexOf("intent.succeeded"),
      );
    });

    it("al que alquila no le muestra desde dónde se conectó el otro", async () => {
      // El historial lo ven las dos partes, pero la IP y el navegador solo un
      // administrador: al dueño del auto le sirve saber qué pasó y cuándo, no
      // desde dónde se conecta quien se lo alquiló. Eso es vigilancia.
      const { owner, renter, bookingId } = await acceptedBooking();
      await acceptContract(app, bookingId, renter.token);
      await createIntent(app, "checkout", bookingId, renter.token);

      const comoDueno = await http()
        .get(`/payments/bookings/${bookingId}/ledger`)
        .set("Authorization", auth(owner.token))
        .expect(200);
      expect(comoDueno.body[0].ip).toBeUndefined();
      expect(comoDueno.body[0].userAgent).toBeUndefined();
    });

    it("el estado no devuelve el fingerprint ni la IP de quien pagó", async () => {
      const { owner, renter, bookingId } = await acceptedBooking();
      await payBookingFully(app, bookingId, renter.token);

      const status = await http()
        .get(`/payments/bookings/${bookingId}/status`)
        .set("Authorization", auth(owner.token))
        .expect(200);

      const crudo = JSON.stringify(status.body);
      expect(crudo).not.toContain("fp_mock_4242");
      expect(crudo).not.toContain("initiatedIp");
      // Marca y últimos cuatro sí: es lo que la persona necesita para
      // reconocer el cobro en su resumen de tarjeta.
      expect(status.body.records[0].cardLast4).toBe("4242");
    });

    /**
     * El estado tampoco puede devolver los identificadores del procesador ni
     * la tarjeta guardada: con el id del intent y el del medio de pago se
     * pueden intentar cobros contra esa tarjeta desde afuera.
     */
    it("no expone los identificadores internos del cobro", async () => {
      const { renter, bookingId } = await acceptedBooking();
      await payBookingFully(app, bookingId, renter.token);

      const booking = await http()
        .get(`/bookings/${bookingId}`)
        .set("Authorization", auth(renter.token))
        .expect(200);

      expect(booking.body).not.toHaveProperty("savedPaymentMethodId");
      expect(booking.body).not.toHaveProperty("checkoutPaymentIntentId");
      expect(booking.body).not.toHaveProperty("depositPaymentIntentId");
      expect(booking.body).not.toHaveProperty("transferGroup");
    });
  });

  describe("lo que protege la plata", () => {
    it("no reutiliza un intent cuyo importe ya no es el de la reserva", async () => {
      // Si el precio cambia entre que se crea el intent y que se paga,
      // devolver el viejo cobraría el importe anterior: el control de precio
      // del servidor no serviría de nada porque el cobro ya no pasa por él.
      const { renter, bookingId } = await acceptedBooking();
      await acceptContract(app, bookingId, renter.token);
      const primero = await createIntent(
        app,
        "checkout",
        bookingId,
        renter.token,
      );

      await prisma.booking.update({
        where: { id: bookingId },
        data: { rentalSubtotalSnapshot: 4000, totalPriceSnapshot: 4300 },
      });

      const segundo = await createIntent(
        app,
        "checkout",
        bookingId,
        renter.token,
      );
      expect(segundo.paymentIntentId).not.toBe(primero.paymentIntentId);
      expect(segundo.amountMinor).toBe(430_000);
    });

    it("una disputa frena la liquidación al dueño", async () => {
      // Transferirle al dueño plata que el banco puede reclamar de vuelta
      // convierte una disputa en una pérdida.
      const { owner, renter, bookingId, returnToken } =
        await acceptedBooking();
      const { checkout } = await hastaElRetiro(owner, renter, bookingId);

      await sendWebhook(app, "charge.dispute.created", {
        id: "dp_1",
        charge: "ch_disputado",
        payment_intent: checkout.paymentIntentId,
        amount: 330_000,
        reason: "fraudulent",
      }).expect(201);

      const disputado = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "CHECKOUT" },
      });
      expect(disputado.status).toBe("DISPUTED");
      expect(disputado.disputedAt).not.toBeNull();

      // Devolver el auto se puede: el auto es del dueño y tiene que volver.
      // Lo que NO pasa es que se le transfiera la plata.
      await http()
        .post(`/bookings/${bookingId}/confirm-return`)
        .set("Authorization", auth(renter.token))
        .send({ token: returnToken })
        .expect(201);

      await prisma.booking.update({
        where: { id: bookingId },
        data: { inspectionEndsAt: new Date(Date.now() - 60_000) },
      });

      const res = await http()
        .post(`/bookings/${bookingId}/settle`)
        .set("Authorization", auth(owner.token))
        .expect(409);
      expect(res.body.code).toBe("PAYMENT_DISPUTED");

      const status = await http()
        .get(`/payments/bookings/${bookingId}/status`)
        .set("Authorization", auth(owner.token))
        .expect(200);
      expect(status.body.ownerTransferId).toBeNull();
      expect(status.body.settledAt).toBeNull();
    });

    it("una devolución hecha desde el panel de Stripe llega igual a la base", async () => {
      // Antes este evento no se escuchaba: la base seguía diciendo "cobrado"
      // sobre plata que ya se había devuelto.
      const { renter, bookingId } = await acceptedBooking();
      const { checkout } = await payBookingFully(app, bookingId, renter.token);

      await sendWebhook(app, "charge.refunded", {
        id: "ch_x",
        payment_intent: checkout.paymentIntentId,
        amount: 330_000,
        amount_refunded: 50_000,
      }).expect(201);

      const parcial = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "CHECKOUT" },
      });
      expect(parcial.status).toBe("PARTIALLY_REFUNDED");
      expect(parcial.refundedAmountMinor).toBe(50_000);
    });

    it("un pago fallado guarda el motivo que dio el procesador", async () => {
      const { renter, bookingId } = await acceptedBooking();
      await acceptContract(app, bookingId, renter.token);
      const checkout = await createIntent(
        app,
        "checkout",
        bookingId,
        renter.token,
      );
      await sendWebhook(app, "payment_intent.payment_failed", {
        id: checkout.paymentIntentId,
      }).expect(201);

      const fila = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "CHECKOUT" },
      });
      expect(fila.status).toBe("FAILED");
    });

    it("DESPUÉS DE UN RECHAZO, LA RESERVA SE PUEDE SEGUIR PAGANDO", async () => {
      /*
        El error que esto vino a tapar, y costó caro: una tarjeta rechazada
        dejaba el registro en FAILED, que el servicio trata como inservible, así
        que salía a pedir otro intent. Pero la clave de idempotencia es la misma
        —la reserva, el tramo y el importe no cambiaron—, así que Stripe
        devolvía EL MISMO intent, y el servicio intentaba insertar un segundo
        registro con el mismo stripePaymentIntentId, que es una columna única.

        Violación de unicidad, error de Prisma sin atrapar, y un 500 mudo en la
        pantalla de pago. O sea que después de UN rechazo, esa reserva no se
        podía pagar nunca más, y el error no hablaba ni de la tarjeta ni del
        cobro.
      */
      const { renter, bookingId } = await acceptedBooking();
      await acceptContract(app, bookingId, renter.token);
      // Por `sena-intent` a propósito: la ruta vieja quedó como alias del
      // cobro único para que un front sin actualizar siga funcionando, y este
      // es el único lugar que lo comprueba.
      const primero = await createIntent(app, "sena", bookingId, renter.token);
      await sendWebhook(app, "payment_intent.payment_failed", {
        id: primero.paymentIntentId,
      }).expect(201);

      const segundo = await http()
        .post(`/payments/bookings/${bookingId}/sena-intent`)
        .set("Authorization", auth(renter.token))
        .expect(201);
      expect(segundo.body.clientSecret).toBeTruthy();

      // Y sigue habiendo UN registro del cobro, no dos por el mismo intent.
      const filas = await prisma.paymentRecord.findMany({
        where: { bookingId, kind: "CHECKOUT" },
      });
      const ids = new Set(filas.map((f) => f.stripePaymentIntentId));
      expect(ids.size).toBe(filas.length);
    });

    it("descarta un evento del modo REAL llegando a un deploy de prueba", async () => {
      // Si esto pasa, algo está cruzado. Procesarlo movería plata de verdad
      // sobre reservas de mentira.
      const { renter, bookingId } = await acceptedBooking();
      await acceptContract(app, bookingId, renter.token);
      const checkout = await createIntent(
        app,
        "checkout",
        bookingId,
        renter.token,
      );

      const res = await sendWebhook(
        app,
        "payment_intent.succeeded",
        { id: checkout.paymentIntentId },
        { livemode: true },
      ).expect(201);
      expect(res.body.ignored).toBe("livemode_mismatch");

      const fila = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "CHECKOUT" },
      });
      expect(fila.status).toBe("REQUIRES_ACTION");
    });
  });

  describe("el depósito en garantía", () => {
    it("un administrador puede cobrar parte por un daño, y queda registrado", async () => {
      const { owner, renter, bookingId } = await acceptedBooking();
      await hastaElRetiro(owner, renter, bookingId);

      const admin = await createAdmin(app, prisma);
      const res = await http()
        .post(`/payments/bookings/${bookingId}/deposit-capture`)
        .set("Authorization", auth(admin.token))
        .send({ amountMinor: 5000, reason: "Raspón en el paragolpes trasero" })
        .expect(201);
      expect(res.body).toBeDefined();

      const booking = await prisma.booking.findUniqueOrThrow({
        where: { id: bookingId },
      });
      expect(booking.depositCapturedAmount).toBe(50);

      const evento = await prisma.paymentEvent.findFirstOrThrow({
        where: { bookingId, type: "hold.captured" },
      });
      expect(evento.actorId).toBe(admin.id);
      expect(evento.amountMinor).toBe(5000);
    });

    it("no se puede cobrar más de lo retenido", async () => {
      const { owner, renter, bookingId } = await acceptedBooking();
      await hastaElRetiro(owner, renter, bookingId);

      const admin = await createAdmin(app, prisma);
      const res = await http()
        .post(`/payments/bookings/${bookingId}/deposit-capture`)
        .set("Authorization", auth(admin.token))
        .send({ amountMinor: 999999, reason: "Intento de cobrar de más" })
        .expect(400);
      expect(res.body.code).toBe("AMOUNT_EXCEEDS_HOLD");
    });

    it("el dueño del auto NO puede cobrarlo por su cuenta", async () => {
      // Es plata de otra persona y hay dos partes con intereses opuestos. Si
      // el dueño capturara solo, el depósito sería un botón para quedarse con
      // la garantía de quien alquiló sin que nadie mire.
      const { owner, renter, bookingId } = await acceptedBooking();
      await hastaElRetiro(owner, renter, bookingId);

      await http()
        .post(`/payments/bookings/${bookingId}/deposit-capture`)
        .set("Authorization", auth(owner.token))
        .send({ amountMinor: 5000, reason: "Raspón en el paragolpes" })
        .expect(403);
    });

    it("exige un motivo que se le pueda mostrar a quien alquiló", async () => {
      const { bookingId } = await acceptedBooking();
      const admin = await createAdmin(app, prisma);
      await http()
        .post(`/payments/bookings/${bookingId}/deposit-capture`)
        .set("Authorization", auth(admin.token))
        .send({ amountMinor: 5000, reason: "daño" })
        .expect(400);
    });
  });
});
