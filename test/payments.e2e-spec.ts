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
import { createIntent, payBookingFully, sendWebhook } from "./helpers/payments";

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
    pickupToken: string;
    returnToken: string;
  }> {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    // pricePerDay 1000, 3 days => subtotal 3000, insurance 300, total 3300,
    // sena 990, balance 2310, deposit 200, ownerPayout 2700.
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
      pickupToken: accepted.body.pickupQrToken,
      returnToken: accepted.body.returnQrToken,
    };
  }

  it("locks server-side pricing snapshots on accept", async () => {
    const { renter, bookingId } = await acceptedBooking();

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    expect(status.body.currency).toBe("usd");
    expect(status.body.total).toBe(3300);
    expect(status.body.sena).toBe(990);
    expect(status.body.balance).toBe(2310);
    expect(status.body.deposit).toBe(200);
    expect(status.body.commission).toBe(300);
    expect(status.body.insurance).toBe(300);
    expect(status.body.ownerPayout).toBe(2700);
    expect(status.body.paymentStatus).toBe("PENDING");
  });

  it("creates a seña intent with the server-computed amount in minor units", async () => {
    const { renter, bookingId } = await acceptedBooking();

    const intent = await createIntent(app, "sena", bookingId, renter.token);
    expect(intent.paymentIntentId).toMatch(/^pi_/);
    expect(intent.clientSecret).toEqual(expect.any(String));
    expect(intent.amountMinor).toBe(99000); // 990.00 USD
    expect(intent.currency).toBe("usd");
  });

  it("marks the booking DEPOSIT_PAID after the seña webhook, then FULLY_PAID after the balance", async () => {
    const { renter, bookingId } = await acceptedBooking();

    const sena = await createIntent(app, "sena", bookingId, renter.token);
    await sendWebhook(app, "payment_intent.succeeded", {
      id: sena.paymentIntentId,
      latest_charge: "ch_sena",
    }).expect(201);

    let status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(status.body.paymentStatus).toBe("DEPOSIT_PAID");

    const balance = await createIntent(app, "balance", bookingId, renter.token);
    await sendWebhook(app, "payment_intent.succeeded", {
      id: balance.paymentIntentId,
      latest_charge: "ch_balance",
    }).expect(201);

    status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(status.body.paymentStatus).toBe("FULLY_PAID");
  });

  it("refuses to create the balance intent before the seña is paid", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await http()
      .post(`/payments/bookings/${bookingId}/balance-intent`)
      .set("Authorization", auth(renter.token))
      .expect(400);
  });

  it("runs the full settlement: ready → pickup → return transfers the owner payout and HOLDS the deposit until the owner checks the car", async () => {
    const { owner, renter, bookingId, pickupToken, returnToken } =
      await acceptedBooking();

    await payBookingFully(app, bookingId, renter.token);

    await http()
      .patch(`/bookings/${bookingId}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    await http()
      .post(`/bookings/${bookingId}/confirm-pickup`)
      .set("Authorization", auth(owner.token))
      .send({ token: pickupToken })
      .expect(201);
    await http()
      .post(`/bookings/${bookingId}/confirm-return`)
      .set("Authorization", auth(renter.token))
      .send({ token: returnToken })
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
    /*
      EL DEPÓSITO SIGUE RETENIDO, Y ES EL CAMBIO.

      Antes se soltaba en el mismo instante en que se confirmaba la devolución,
      y eso dejaba el reclamo por daños en una situación imposible: cuando el
      dueño se acercaba al auto y veía el golpe, la retención ya no existía y no
      había nada que capturar. Ahora queda retenido mientras dura la ventana de
      revisión (claims/claim-window.ts).
    */
    expect(kinds).toContain("DEPOSIT_HOLD:AUTHORIZED");
    expect(kinds).not.toContain("DEPOSIT_HOLD:RELEASED");

    // Y se suelta cuando el dueño dice que está todo bien, que es el camino
    // normal y el que el mail le pide.
    await http()
      .post(`/bookings/${bookingId}/inspection-ok`)
      .set("Authorization", auth(owner.token))
      .expect(201);

    const despues = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    const kindsDespues = despues.body.records.map(
      (r: { kind: string; status: string }) => `${r.kind}:${r.status}`,
    );
    expect(kindsDespues).toContain("DEPOSIT_HOLD:RELEASED");

    // Owner now has a connected account on file.
    const ownerRow = await prisma.user.findUnique({ where: { id: owner.id } });
    expect(ownerRow?.stripeAccountId).toMatch(/^acct_/);
  });

  it("blocks ready-for-pickup until fully paid and the deposit is authorized", async () => {
    const { owner, renter, bookingId } = await acceptedBooking();

    // Only the seña is paid.
    const sena = await createIntent(app, "sena", bookingId, renter.token);
    await sendWebhook(app, "payment_intent.succeeded", {
      id: sena.paymentIntentId,
    }).expect(201);

    await http()
      .patch(`/bookings/${bookingId}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(400);
  });

  it("rejects a webhook with an invalid signature", async () => {
    const { renter, bookingId } = await acceptedBooking();
    const sena = await createIntent(app, "sena", bookingId, renter.token);
    await http()
      .post("/payments/stripe/webhook")
      .set("Stripe-Signature", "t=1,v1=deadbeef")
      .set("Content-Type", "application/json")
      .send(
        JSON.stringify({
          id: "evt_bad",
          type: "payment_intent.succeeded",
          data: { object: { id: sena.paymentIntentId } },
        }),
      )
      .expect(400);
  });

  it("processes each webhook event id only once (idempotent)", async () => {
    const { renter, bookingId } = await acceptedBooking();
    const sena = await createIntent(app, "sena", bookingId, renter.token);

    const first = await sendWebhook(
      app,
      "payment_intent.succeeded",
      { id: sena.paymentIntentId },
      { id: "evt_dup_1" },
    ).expect(201);
    expect(first.body.duplicate).toBe(false);

    const second = await sendWebhook(
      app,
      "payment_intent.succeeded",
      { id: sena.paymentIntentId },
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

  it("refunds the captured charges when a paid booking is cancelled", async () => {
    const { owner, renter, bookingId } = await acceptedBooking();
    await payBookingFully(app, bookingId, renter.token);

    await http()
      .patch(`/bookings/${bookingId}/cancel`)
      .set("Authorization", auth(owner.token))
      .send({ reason: "owner unavailable" })
      .expect(200);

    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(status.body.paymentStatus).toBe("REFUNDED");
    const kinds = status.body.records.map((r: { kind: string }) => r.kind);
    expect(kinds).toContain("REFUND");
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

      const sena = await http()
        .post(`/payments/bookings/${bookingId}/sena-intent`)
        .set("Authorization", auth(renter.token))
        .set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
        .set("User-Agent", "FreeWheelApp/1.0")
        .expect(201);

      const creado = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "SENA" },
      });
      // La IP del CLIENTE, no la del proxy: x-forwarded-for trae la cadena y
      // el primero es quien pidió.
      expect(creado.initiatedIp).toBe("203.0.113.7");
      expect(creado.initiatedUserAgent).toBe("FreeWheelApp/1.0");

      await sendWebhook(app, "payment_intent.succeeded", {
        id: sena.body.paymentIntentId,
      }).expect(201);

      const cobrado = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "SENA" },
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
      const sena = await createIntent(app, "sena", bookingId, renter.token);
      await sendWebhook(app, "payment_intent.succeeded", {
        id: sena.paymentIntentId,
      }).expect(201);

      const ledger = await http()
        .get(`/payments/bookings/${bookingId}/ledger`)
        .set("Authorization", auth(renter.token))
        .expect(200);

      const tipos = (ledger.body as { type: string }[]).map((e) => e.type);
      expect(tipos).toEqual(["sena.intent.created", "intent.succeeded"]);
    });

    it("al que alquila no le muestra desde dónde se conectó el otro", async () => {
      // El historial lo ven las dos partes, pero la IP y el navegador solo un
      // administrador: al dueño del auto le sirve saber qué pasó y cuándo, no
      // desde dónde se conecta quien se lo alquiló. Eso es vigilancia.
      const { owner, renter, bookingId } = await acceptedBooking();
      await createIntent(app, "sena", bookingId, renter.token);

      const comoDueno = await http()
        .get(`/payments/bookings/${bookingId}/ledger`)
        .set("Authorization", auth(owner.token))
        .expect(200);
      expect(comoDueno.body[0].ip).toBeUndefined();
      expect(comoDueno.body[0].userAgent).toBeUndefined();
    });

    it("el estado no devuelve el fingerprint ni la IP de quien pagó", async () => {
      const { owner, renter, bookingId } = await acceptedBooking();
      const sena = await createIntent(app, "sena", bookingId, renter.token);
      await sendWebhook(app, "payment_intent.succeeded", {
        id: sena.paymentIntentId,
      }).expect(201);

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
  });

  describe("lo que protege la plata", () => {
    it("no reutiliza un intent cuyo importe ya no es el de la reserva", async () => {
      // Si el precio cambia entre que se crea el intent y que se paga,
      // devolver el viejo cobraría el importe anterior: el control de precio
      // del servidor no serviría de nada porque el cobro ya no pasa por él.
      const { renter, bookingId } = await acceptedBooking();
      const primero = await createIntent(app, "sena", bookingId, renter.token);

      await prisma.booking.update({
        where: { id: bookingId },
        data: { senaAmountSnapshot: 1500 },
      });

      const segundo = await createIntent(app, "sena", bookingId, renter.token);
      expect(segundo.paymentIntentId).not.toBe(primero.paymentIntentId);
      expect(segundo.amountMinor).toBe(150000);
    });

    it("el saldo exige que la seña esté COBRADA, no que la reserva no esté pendiente", async () => {
      const { renter, bookingId } = await acceptedBooking();
      const res = await http()
        .post(`/payments/bookings/${bookingId}/balance-intent`)
        .set("Authorization", auth(renter.token))
        .expect(400);
      expect(res.body.code).toBe("SENA_NOT_PAID");
    });

    it("una disputa frena la liquidación al dueño", async () => {
      // Transferirle al dueño plata que el banco puede reclamar de vuelta
      // convierte una disputa en una pérdida.
      const { owner, renter, bookingId, pickupToken, returnToken } =
        await acceptedBooking();
      const { sena } = await payBookingFully(app, bookingId, renter.token);

      await http()
        .patch(`/bookings/${bookingId}/ready-for-pickup`)
        .set("Authorization", auth(owner.token))
        .expect(200);
      await http()
        .post(`/bookings/${bookingId}/confirm-pickup`)
        .set("Authorization", auth(owner.token))
        .send({ token: pickupToken })
        .expect(201);

      await sendWebhook(app, "charge.dispute.created", {
        id: "dp_1",
        charge: "ch_disputado",
        payment_intent: sena.paymentIntentId,
        amount: 99000,
        reason: "fraudulent",
      }).expect(201);

      const disputado = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "SENA" },
      });
      expect(disputado.status).toBe("DISPUTED");
      expect(disputado.disputedAt).not.toBeNull();

      /*
        LA DEVOLUCIÓN SE CONFIRMA IGUAL, LA LIQUIDACIÓN NO.

        Antes esto contestaba 400 y la devolución no se escribía. Pero el auto
        volvió: frenar la entrega física por un problema de plata dejaba la
        reserva abierta para siempre, y encima con el auto ya en la playa del
        dueño. Lo que hay que frenar es la plata, no la devolución.

        Así que ahora la devolución entra, y el motivo vuelve en `settlement`
        para que la pantalla lo pueda contar sin llamarlo error.
      */
      const res = await http()
        .post(`/bookings/${bookingId}/confirm-return`)
        .set("Authorization", auth(renter.token))
        .send({ token: returnToken })
        .expect(201);
      expect(res.body.status).toBe("COMPLETED");
      expect(res.body.settlement.ok).toBe(false);
      expect(res.body.settlement.code).toBe("PAYMENT_DISPUTED");

      // Y lo importante: al dueño no le llegó un peso.
      const conDisputa = await prisma.booking.findFirstOrThrow({
        where: { id: bookingId },
      });
      expect(conDisputa.ownerTransferId).toBeNull();
    });

    it("una devolución hecha desde el panel de Stripe llega igual a la base", async () => {
      // Antes este evento no se escuchaba: la base seguía diciendo "cobrado"
      // sobre plata que ya se había devuelto.
      const { renter, bookingId } = await acceptedBooking();
      const sena = await createIntent(app, "sena", bookingId, renter.token);
      await sendWebhook(app, "payment_intent.succeeded", {
        id: sena.paymentIntentId,
      }).expect(201);

      await sendWebhook(app, "charge.refunded", {
        id: "ch_x",
        payment_intent: sena.paymentIntentId,
        amount: 99000,
        amount_refunded: 50000,
      }).expect(201);

      const parcial = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "SENA" },
      });
      expect(parcial.status).toBe("PARTIALLY_REFUNDED");
      expect(parcial.refundedAmountMinor).toBe(50000);
    });

    it("un pago fallado guarda el motivo que dio el procesador", async () => {
      const { renter, bookingId } = await acceptedBooking();
      const sena = await createIntent(app, "sena", bookingId, renter.token);
      await sendWebhook(app, "payment_intent.payment_failed", {
        id: sena.paymentIntentId,
      }).expect(201);

      const fila = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "SENA" },
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
      const primero = await createIntent(app, "sena", bookingId, renter.token);
      await sendWebhook(app, "payment_intent.payment_failed", {
        id: primero.paymentIntentId,
      }).expect(201);

      const segundo = await http()
        .post(`/payments/bookings/${bookingId}/sena-intent`)
        .set("Authorization", auth(renter.token))
        .expect(201);
      expect(segundo.body.clientSecret).toBeTruthy();

      // Y sigue habiendo UN registro de la seña, no dos por el mismo intent.
      const filas = await prisma.paymentRecord.findMany({
        where: { bookingId, kind: "SENA" },
      });
      const ids = new Set(filas.map((f) => f.stripePaymentIntentId));
      expect(ids.size).toBe(filas.length);
    });

    it("descarta un evento del modo REAL llegando a un deploy de prueba", async () => {
      // Si esto pasa, algo está cruzado. Procesarlo movería plata de verdad
      // sobre reservas de mentira.
      const { renter, bookingId } = await acceptedBooking();
      const sena = await createIntent(app, "sena", bookingId, renter.token);

      const res = await sendWebhook(
        app,
        "payment_intent.succeeded",
        { id: sena.paymentIntentId },
        { livemode: true },
      ).expect(201);
      expect(res.body.ignored).toBe("livemode_mismatch");

      const fila = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "SENA" },
      });
      expect(fila.status).toBe("REQUIRES_ACTION");
    });
  });

  describe("el depósito en garantía", () => {
    it("un administrador puede cobrar parte por un daño, y queda registrado", async () => {
      const { owner, renter, bookingId, pickupToken } = await acceptedBooking();
      await payBookingFully(app, bookingId, renter.token);
      await http()
        .patch(`/bookings/${bookingId}/ready-for-pickup`)
        .set("Authorization", auth(owner.token))
        .expect(200);
      await http()
        .post(`/bookings/${bookingId}/confirm-pickup`)
        .set("Authorization", auth(owner.token))
        .send({ token: pickupToken })
        .expect(201);

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
      const { owner, renter, bookingId, pickupToken } = await acceptedBooking();
      await payBookingFully(app, bookingId, renter.token);
      await http()
        .patch(`/bookings/${bookingId}/ready-for-pickup`)
        .set("Authorization", auth(owner.token))
        .expect(200);
      await http()
        .post(`/bookings/${bookingId}/confirm-pickup`)
        .set("Authorization", auth(owner.token))
        .send({ token: pickupToken })
        .expect(201);

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
      const { owner, renter, bookingId, pickupToken } = await acceptedBooking();
      await payBookingFully(app, bookingId, renter.token);
      await http()
        .patch(`/bookings/${bookingId}/ready-for-pickup`)
        .set("Authorization", auth(owner.token))
        .expect(200);
      await http()
        .post(`/bookings/${bookingId}/confirm-pickup`)
        .set("Authorization", auth(owner.token))
        .send({ token: pickupToken })
        .expect(201);

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
