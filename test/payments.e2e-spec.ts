import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import { PaymentsService } from "../src/payments/payments.service";
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
  authorizeDeposit,
  checkout,
  linkOwnerMercadoPago,
  mercadoPago,
  payBookingFully,
  sendNotification,
  tarjeta,
} from "./helpers/payments";

/**
 * LOS PAGOS, DE PUNTA A PUNTA, CON EL MODELO DE MERCADO PAGO.
 *
 * Corren contra el provider de pruebas, que se comporta como Mercado Pago:
 * el resultado de un pago lo decide el "titular" de la tarjeta (APRO, FUND,
 * CONT…, como en el sandbox), los avisos van firmados con la misma función que
 * verifica producción, y las pruebas pueden cambiar cosas "del lado de
 * Mercado Pago" (una devolución desde el panel, una contracara) para ver que
 * el servidor se entera.
 */
describe("Payments (Mercado Pago, split de pagos)", () => {
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
    mercadoPago(app).simularFallaEnDevoluciones(false);
  });

  /**
   * Dueño con Mercado Pago vinculado + quien alquila + reserva ACEPTADA.
   * 1000 por día × 3 días: alquiler 3000, cobertura 300, total 3300, comisión
   * 300, seña 900 (30 % del alquiler), depósito 200.
   */
  async function acceptedBooking(
    opts: { startInDays?: number } = {},
  ): Promise<{
    owner: AuthedUser;
    renter: AuthedUser;
    bookingId: string;
    returnToken: string;
    mpUserId: string;
  }> {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    const listing = await createListing(app, owner.token, vehicle.id, {
      pricePerDay: 1000,
    });
    const mpUserId = await linkOwnerMercadoPago(app, owner);
    const renter = await registerUser(app);
    const inicio = opts.startInDays ?? 5;
    const created = await http()
      .post("/bookings")
      .set("Authorization", auth(renter.token))
      .send({
        listingId: listing.id,
        startDate: futureDate(inicio),
        endDate: futureDate(inicio + 3),
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
      mpUserId,
    };
  }

  /** Paga, autoriza el depósito, marca listo y confirma el retiro. */
  async function hastaElRetiro(
    owner: AuthedUser,
    renter: AuthedUser,
    bookingId: string,
  ) {
    const pagos = await payBookingFully(app, bookingId, renter.token);
    await authorizeDeposit(app, bookingId, renter.token);
    await http()
      .patch(`/bookings/${bookingId}/ready-for-pickup`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    const tokens = await http()
      .get(`/bookings/${bookingId}/tokens`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    await http()
      .post(`/bookings/${bookingId}/confirm-pickup`)
      .set("Authorization", auth(owner.token))
      .send({ token: tokens.body.pickupQrToken })
      .expect(201);
    return pagos;
  }

  async function estado(bookingId: string, token: string) {
    const res = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(token))
      .expect(200);
    return res.body as {
      paymentStatus: string;
      depositStatus: string | null;
      depositHoldExpiresAt: string | null;
      settledAt: string | null;
      ownerTransferId: string | null;
      records: {
        kind: string;
        status: string;
        cardLast4: string | null;
        failureCode: string | null;
        refundedAmountMinor: number;
      }[];
    };
  }

  async function saldos(adminToken: string) {
    const res = await http()
      .get("/payments/admin/ledger/balances")
      .set("Authorization", auth(adminToken))
      .expect(200);
    const lista = res.body as { account: string; balanceMinor: number }[];
    return (cuenta: string) =>
      lista.find((s) => s.account === cuenta)?.balanceMinor ?? 0;
  }

  const tipos = (records: { kind: string; status: string }[]) =>
    records.map((r) => `${r.kind}:${r.status}`);

  // ── Vincular la cuenta del dueño ──────────────────────────────────────────

  describe("la cuenta de Mercado Pago del dueño", () => {
    it("sin vincularla, el dueño no puede aceptar una reserva", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
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

      const res = await http()
        .patch(`/bookings/${created.body.id}/accept`)
        .set("Authorization", auth(owner.token))
        .expect(409);
      expect(res.body.code).toBe("OWNER_PAYMENTS_NOT_LINKED");
    });

    it("vincularla la deja lista para cobrar, con los tokens CIFRADOS", async () => {
      const owner = await registerUser(app);
      const mpUserId = await linkOwnerMercadoPago(app, owner);

      const status = await http()
        .get("/payments/connect/status")
        .set("Authorization", auth(owner.token))
        .expect(200);
      expect(status.body).toMatchObject({
        provider: "mock",
        connected: true,
        liveMode: false,
        modeMatches: true,
      });

      // Con el access token se puede cobrar y devolver en la cuenta de esa
      // persona: en la base no puede estar en claro.
      const fila = await prisma.user.findUniqueOrThrow({
        where: { id: owner.id },
      });
      expect(fila.mpUserId).toBe(mpUserId);
      expect(fila.mpAccessTokenEnc).toMatch(/^enc:v1:/);
      expect(fila.mpAccessTokenEnc).not.toContain("TEST-mock-access");
      expect(fila.mpRefreshTokenEnc).toMatch(/^enc:v1:/);
    });

    it("una vuelta sin state válido o cancelada por la persona termina en error", async () => {
      const malo = await http()
        .get("/payments/mercadopago/oauth/callback")
        .query({ code: "abc", state: "esto-no-es-un-state" })
        .expect(302);
      expect(malo.headers.location).toContain("status=error");
      expect(malo.headers.location).toContain("code=MP_INVALID_STATE");

      const cancelada = await http()
        .get("/payments/mercadopago/oauth/callback")
        .query({ error: "access_denied" })
        .expect(302);
      expect(cancelada.headers.location).toContain(
        "code=MP_AUTHORIZATION_DENIED",
      );
    });

    it("una misma cuenta de Mercado Pago no puede cobrar para dos usuarios", async () => {
      const uno = await registerUser(app);
      const otro = await registerUser(app);
      await linkOwnerMercadoPago(app, uno);

      // El segundo usuario vuelve con el MISMO código: el mismo user_id de
      // Mercado Pago.
      const inicio = await http()
        .post("/payments/connect/onboarding")
        .set("Authorization", auth(otro.token))
        .expect(201);
      const state = new URL(
        inicio.body.onboardingUrl as string,
      ).searchParams.get("state");
      const res = await http()
        .get("/payments/mercadopago/oauth/callback")
        .query({
          code: `codigo${uno.id.replace(/-/g, "").slice(0, 16)}`,
          state,
        })
        .expect(302);
      expect(res.headers.location).toContain("code=MP_ACCOUNT_ALREADY_LINKED");
    });

    it("no se puede desvincular con cobros sin cerrar, y sí después", async () => {
      const { owner, renter, bookingId } = await acceptedBooking();
      await payBookingFully(app, bookingId, renter.token);

      const res = await http()
        .delete("/payments/connect")
        .set("Authorization", auth(owner.token))
        .expect(409);
      expect(res.body.code).toBe("OWNER_HAS_ACTIVE_PAYMENTS");

      await prisma.booking.update({
        where: { id: bookingId },
        data: { settledAt: new Date() },
      });
      await http()
        .delete("/payments/connect")
        .set("Authorization", auth(owner.token))
        .expect(200);
    });

    it("si el dueño la desvincula desde Mercado Pago, sus credenciales se borran", async () => {
      const owner = await registerUser(app);
      const mpUserId = await linkOwnerMercadoPago(app, owner);

      await sendNotification(app, "mp-connect", mpUserId, {
        action: "application.deauthorized",
        userId: mpUserId,
      }).expect(200);

      const fila = await prisma.user.findUniqueOrThrow({
        where: { id: owner.id },
      });
      expect(fila.mpAccessTokenEnc).toBeNull();
      expect(fila.mpRefreshTokenEnc).toBeNull();
    });
  });

  // ── El cobro de la reserva ────────────────────────────────────────────────

  it("congela los precios al aceptar, en pesos", async () => {
    const { renter, bookingId } = await acceptedBooking();
    const status = await http()
      .get(`/payments/bookings/${bookingId}/status`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    expect(status.body).toMatchObject({
      provider: "mock",
      currency: "ars",
      total: 3300,
      sena: 900,
      balance: null,
      deposit: 200,
      commission: 300,
      insurance: 300,
      ownerPayout: 2700,
      paymentStatus: "PENDING",
    });
  });

  it("da lo que el formulario necesita: la clave pública DEL DUEÑO y el importe", async () => {
    const { renter, bookingId } = await acceptedBooking();
    const res = await http()
      .get(`/payments/bookings/${bookingId}/checkout`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    expect(res.body).toMatchObject({
      publicKey: expect.stringMatching(/^TEST-mock-pk-/) as unknown,
      currency: "ARS",
      amountMinor: 330_000,
      amount: 3300,
      contractAccepted: false,
      alreadyPaid: false,
    });
    expect(res.body.ticket.processor.name).toBe("mercadopago");
  });

  it("no deja pagar antes de aceptar el contrato", async () => {
    const { renter, bookingId } = await acceptedBooking();
    const res = await http()
      .post(`/payments/bookings/${bookingId}/checkout`)
      .set("Authorization", auth(renter.token))
      .send(tarjeta())
      .expect(409);
    expect(res.body.code).toBe("CONTRACT_NOT_ACCEPTED");
  });

  it("cobra todo junto en la cuenta del dueño, con la comisión de FreeWheel", async () => {
    const { renter, bookingId, mpUserId } = await acceptedBooking();
    await acceptContract(app, bookingId, renter.token);

    const pago = await checkout(app, bookingId, renter.token);
    expect(pago).toMatchObject({
      status: "approved",
      approved: true,
      bookingPaymentStatus: "FULLY_PAID",
    });

    // Lo que le llegó a Mercado Pago: el importe del servidor, no el que
    // mandó el front (el formulario manda transaction_amount: 1), en la
    // cuenta del dueño.
    expect(mercadoPago(app).consultar(pago.paymentId)).toMatchObject({
      amountMinor: 330_000,
      collectorId: mpUserId,
      externalReference: bookingId,
    });

    const fila = await prisma.paymentRecord.findFirstOrThrow({
      where: { bookingId, kind: "CHECKOUT" },
    });
    expect(fila).toMatchObject({
      status: "CAPTURED",
      amountMinor: 330_000,
      applicationFeeMinor: 60_000,
      collectorId: mpUserId,
      cardLast4: "3704",
    });
    expect(fila.cardFingerprint).toMatch(/^mpfp_/);
  });

  it("una tarjeta rechazada lo dice en castellano, y se puede pagar con otra", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await acceptContract(app, bookingId, renter.token);

    const rechazo = await checkout(app, bookingId, renter.token, "FUND");
    expect(rechazo).toMatchObject({
      status: "rejected",
      approved: false,
      statusDetail: "cc_rejected_insufficient_amount",
      message: "La tarjeta no tiene fondos suficientes.",
    });
    expect((await estado(bookingId, renter.token)).paymentStatus).toBe(
      "FAILED",
    );

    const segunda = await checkout(app, bookingId, renter.token, "APRO");
    expect(segunda.approved).toBe(true);
    const final = await estado(bookingId, renter.token);
    expect(final.paymentStatus).toBe("FULLY_PAID");
    expect(tipos(final.records)).toEqual(
      expect.arrayContaining(["CHECKOUT:FAILED", "CHECKOUT:CAPTURED"]),
    );
  });

  it("un pago en revisión no deja cobrar otro encima, y el aviso lo resuelve", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await acceptContract(app, bookingId, renter.token);

    const enRevision = await checkout(app, bookingId, renter.token, "CONT");
    expect(enRevision.status).toBe("in_process");

    const otro = await http()
      .post(`/payments/bookings/${bookingId}/checkout`)
      .set("Authorization", auth(renter.token))
      .send(tarjeta())
      .expect(409);
    expect(otro.body.code).toBe("PAYMENT_IN_PROCESS");

    // Mercado Pago lo aprueba y avisa.
    mercadoPago(app).simularCambio(enRevision.paymentId, {
      status: "approved",
      statusDetail: "accredited",
      capturedMinor: 330_000,
    });
    await sendNotification(app, "payment", enRevision.paymentId).expect(200);

    expect((await estado(bookingId, renter.token)).paymentStatus).toBe(
      "FULLY_PAID",
    );
  });

  it("una reserva paga no se cobra dos veces", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await payBookingFully(app, bookingId, renter.token);
    const res = await http()
      .post(`/payments/bookings/${bookingId}/checkout`)
      .set("Authorization", auth(renter.token))
      .send(tarjeta())
      .expect(409);
    expect(res.body.code).toBe("ALREADY_PAID");
  });

  it("las rutas viejas: sena-intent es un alias, balance-intent ya no existe", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await acceptContract(app, bookingId, renter.token);

    const alias = await http()
      .post(`/payments/bookings/${bookingId}/sena-intent`)
      .set("Authorization", auth(renter.token))
      .send(tarjeta())
      .expect(201);
    expect(alias.body.approved).toBe(true);

    const saldo = await http()
      .post(`/payments/bookings/${bookingId}/balance-intent`)
      .set("Authorization", auth(renter.token))
      .expect(409);
    expect(saldo.body.code).toBe("PAYMENT_IS_SINGLE");
  });

  it("una reserva congelada en dólares no se puede cobrar con Mercado Pago", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await acceptContract(app, bookingId, renter.token);
    await prisma.booking.update({
      where: { id: bookingId },
      data: { currency: "usd" },
    });

    const res = await http()
      .post(`/payments/bookings/${bookingId}/checkout`)
      .set("Authorization", auth(renter.token))
      .send(tarjeta())
      .expect(409);
    expect(res.body.code).toBe("CURRENCY_NOT_SUPPORTED");
  });

  it("valida el cuerpo del formulario: sin token, no hay pago", async () => {
    const { renter, bookingId } = await acceptedBooking();
    await acceptContract(app, bookingId, renter.token);
    const { token: _sinToken, ...sinToken } = tarjeta();
    await http()
      .post(`/payments/bookings/${bookingId}/checkout`)
      .set("Authorization", auth(renter.token))
      .send(sinToken)
      .expect(400);
  });

  // ── Los avisos de Mercado Pago ────────────────────────────────────────────

  describe("los avisos", () => {
    it("rechaza un aviso con la firma mal", async () => {
      const res = await sendNotification(app, "payment", "123", {
        firma: "ts=1,v1=deadbeef",
      }).expect(400);
      expect(res.body.code).toBe("INVALID_NOTIFICATION_SIGNATURE");
    });

    it("procesa cada aviso una sola vez", async () => {
      const { renter, bookingId } = await acceptedBooking();
      const { checkout: pago } = await payBookingFully(
        app,
        bookingId,
        renter.token,
      );

      const primero = await sendNotification(app, "payment", pago.paymentId, {
        notificationId: "aviso-1",
      }).expect(200);
      expect(primero.body.duplicate).toBe(false);
      const segundo = await sendNotification(app, "payment", pago.paymentId, {
        notificationId: "aviso-1",
      }).expect(200);
      expect(segundo.body.duplicate).toBe(true);
    });

    it("descarta un aviso de PRODUCCIÓN llegando a un deploy de prueba", async () => {
      const res = await sendNotification(app, "payment", "123", {
        liveMode: true,
      }).expect(200);
      expect(res.body.ignored).toBe("livemode_mismatch");
    });

    it("una devolución hecha desde el panel de Mercado Pago llega igual a la base", async () => {
      const { renter, bookingId } = await acceptedBooking();
      const { checkout: pago } = await payBookingFully(
        app,
        bookingId,
        renter.token,
      );

      mercadoPago(app).simularCambio(pago.paymentId, { refundedMinor: 50_000 });
      await sendNotification(app, "payment", pago.paymentId).expect(200);

      const fila = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "CHECKOUT" },
      });
      expect(fila.status).toBe("PARTIALLY_REFUNDED");
      expect(fila.refundedAmountMinor).toBe(50_000);
    });

    /**
     * El pedido llegó a Mercado Pago pero la respuesta se perdió: el cobro
     * existe y la persona pagó. Si el aviso se ignorara, la reserva quedaría
     * impaga con la plata cobrada.
     */
    it("adopta un cobro cuya respuesta nunca llegó", async () => {
      const { renter, bookingId, mpUserId } = await acceptedBooking();
      await acceptContract(app, bookingId, renter.token);

      // El cobro se hace en Mercado Pago "por fuera" del servidor.
      const huerfano = await mercadoPago(app).createPayment({
        bookingId,
        kind: "CHECKOUT",
        amountMinor: 330_000,
        currency: "ars",
        applicationFeeMinor: 60_000,
        capture: true,
        card: {
          token: "tok_APRO_huerfano",
          paymentMethodId: "visa",
          installments: 1,
          payer: { email: "x@y.com" },
        },
        collector: { userId: mpUserId, accessToken: "x" },
        description: "x",
        externalReference: bookingId,
        idempotencyKey: "perdido",
      });

      await sendNotification(app, "payment", huerfano.id, {
        userId: mpUserId,
      }).expect(200);

      expect((await estado(bookingId, renter.token)).paymentStatus).toBe(
        "FULLY_PAID",
      );
    });

    it("la conciliación diaria resuelve un pago aunque el aviso no llegue nunca", async () => {
      const { renter, bookingId } = await acceptedBooking();
      await acceptContract(app, bookingId, renter.token);
      const enRevision = await checkout(app, bookingId, renter.token, "CONT");

      mercadoPago(app).simularCambio(enRevision.paymentId, {
        status: "approved",
        capturedMinor: 330_000,
      });
      // Sin aviso. La conciliación corre "más tarde".
      const enUnaHora = new Date(Date.now() + 60 * 60 * 1000);
      await app.get(PaymentsService).reconcilePendingPayments(enUnaHora);

      expect((await estado(bookingId, renter.token)).paymentStatus).toBe(
        "FULLY_PAID",
      );
    });
  });

  // ── El depósito en garantía ───────────────────────────────────────────────

  describe("el depósito en garantía", () => {
    it("se autoriza después de pagar, como una reserva de fondos de 7 días", async () => {
      const { renter, bookingId } = await acceptedBooking();

      const antes = await http()
        .post(`/payments/bookings/${bookingId}/deposit-hold`)
        .set("Authorization", auth(renter.token))
        .send(tarjeta())
        .expect(409);
      expect(antes.body.code).toBe("CHECKOUT_NOT_PAID");

      await payBookingFully(app, bookingId, renter.token);
      const deposito = await authorizeDeposit(app, bookingId, renter.token);
      expect(deposito).toMatchObject({ status: "authorized", approved: true });

      const final = await estado(bookingId, renter.token);
      expect(final.depositStatus).toBe("AUTHORIZED");
      const horas =
        (new Date(final.depositHoldExpiresAt!).getTime() - Date.now()) /
        3_600_000;
      expect(horas).toBeGreaterThan(150);
      expect(horas).toBeLessThan(169);
    });

    it("demasiado lejos del retiro todavía no se puede autorizar", async () => {
      const { renter, bookingId } = await acceptedBooking({ startInDays: 40 });
      await payBookingFully(app, bookingId, renter.token);

      const res = await http()
        .post(`/payments/bookings/${bookingId}/deposit-hold`)
        .set("Authorization", auth(renter.token))
        .send(tarjeta())
        .expect(409);
      expect(res.body.code).toBe("DEPOSIT_TOO_EARLY");
      expect(res.body.availableFrom).toEqual(expect.any(String));
    });

    it("sin depósito autorizado no se entrega el auto", async () => {
      const { owner, renter, bookingId } = await acceptedBooking();
      await payBookingFully(app, bookingId, renter.token);

      const res = await http()
        .patch(`/bookings/${bookingId}/ready-for-pickup`)
        .set("Authorization", auth(owner.token))
        .expect(409);
      expect(res.body.code).toBe("DEPOSIT_AUTHORIZATION_REQUIRED");

      await authorizeDeposit(app, bookingId, renter.token);
      await http()
        .patch(`/bookings/${bookingId}/ready-for-pickup`)
        .set("Authorization", auth(owner.token))
        .expect(200);
    });

    it("un administrador cobra parte por un daño; el dueño no puede solo", async () => {
      const { owner, renter, bookingId } = await acceptedBooking();
      await hastaElRetiro(owner, renter, bookingId);

      await http()
        .post(`/payments/bookings/${bookingId}/deposit-capture`)
        .set("Authorization", auth(owner.token))
        .send({ amountMinor: 5000, reason: "Raspón en el paragolpes" })
        .expect(403);

      const admin = await createAdmin(app, prisma);
      const exceso = await http()
        .post(`/payments/bookings/${bookingId}/deposit-capture`)
        .set("Authorization", auth(admin.token))
        .send({ amountMinor: 999_999, reason: "Intento de cobrar de más" })
        .expect(400);
      expect(exceso.body.code).toBe("AMOUNT_EXCEEDS_HOLD");

      await http()
        .post(`/payments/bookings/${bookingId}/deposit-capture`)
        .set("Authorization", auth(admin.token))
        .send({ amountMinor: 5000, reason: "Raspón en el paragolpes trasero" })
        .expect(201);

      const booking = await prisma.booking.findUniqueOrThrow({
        where: { id: bookingId },
      });
      expect(booking.depositCapturedAmount).toBe(50);
      const hold = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "DEPOSIT_HOLD" },
      });
      // Lo cobrado entró a la cuenta del dueño: se capturó sobre su cobro.
      expect(mercadoPago(app).consultar(hold.providerPaymentId!)).toMatchObject(
        { status: "approved", capturedMinor: 5000 },
      );
    });
  });

  // ── El cierre ─────────────────────────────────────────────────────────────

  describe("el cierre de la reserva", () => {
    it("la inspección vencida suelta el depósito; al dueño no hay que transferirle nada", async () => {
      const { owner, renter, bookingId, returnToken } = await acceptedBooking();
      await hastaElRetiro(owner, renter, bookingId);

      await http()
        .post(`/bookings/${bookingId}/confirm-return`)
        .set("Authorization", auth(renter.token))
        .send({ token: returnToken })
        .expect(201);
      // Durante la inspección el depósito sigue retenido.
      expect((await estado(bookingId, renter.token)).depositStatus).toBe(
        "AUTHORIZED",
      );

      await prisma.booking.update({
        where: { id: bookingId },
        data: { inspectionEndsAt: new Date(Date.now() - 60_000) },
      });
      await http()
        .post(`/bookings/${bookingId}/settle`)
        .set("Authorization", auth(owner.token))
        .expect(201);

      const final = await estado(bookingId, renter.token);
      expect(final.depositStatus).toBe("RELEASED");
      expect(final.settledAt).toEqual(expect.any(String));
      // Con el split no hay transferencia: el dueño cobró en el momento.
      expect(final.ownerTransferId).toBeNull();
      expect(tipos(final.records)).not.toContain("OWNER_TRANSFER:PAID");
    });

    it("el dueño cierra la revisión antes de tiempo con 'está todo bien'", async () => {
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
      expect((await estado(bookingId, renter.token)).depositStatus).toBe(
        "RELEASED",
      );
    });

    it("una contracara frena el cierre", async () => {
      const { owner, renter, bookingId, returnToken, mpUserId } =
        await acceptedBooking();
      const { checkout: pago } = await hastaElRetiro(owner, renter, bookingId);

      const contracargo = mercadoPago(app).simularContracargo(pago.paymentId);
      await sendNotification(app, "chargebacks", contracargo, {
        userId: mpUserId,
      }).expect(200);

      const fila = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "CHECKOUT" },
      });
      expect(fila.status).toBe("DISPUTED");

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
    });

    it("el libro: la parte de FreeWheel en sus bolsillos, la del dueño en cuentas de orden", async () => {
      const { owner, renter, bookingId } = await acceptedBooking();
      await payBookingFully(app, bookingId, renter.token);

      const admin = await createAdmin(app, prisma);
      const asientos = await http()
        .get(`/payments/admin/ledger/bookings/${bookingId}`)
        .set("Authorization", auth(admin.token))
        .expect(200);
      for (const asiento of asientos.body as {
        entries: { amountMinor: number }[];
      }[]) {
        expect(asiento.entries.reduce((t, e) => t + e.amountMinor, 0)).toBe(0);
      }

      const saldo = await saldos(admin.token);
      expect(saldo("platform:commission")).toBe(30_000);
      expect(saldo("insurance:payable")).toBe(30_000);
      expect(saldo(`split:owner:${owner.id}:direct`)).toBe(270_000);
      // Nada retenido a nombre de la reserva: con el split, FreeWheel no
      // custodia la plata del dueño.
      expect(saldo(`booking:${bookingId}:rental`)).toBe(0);
    });
  });

  // ── Cancelaciones ─────────────────────────────────────────────────────────

  describe("cancelar", () => {
    it("si cancela el dueño, se devuelve todo y queda debiendo la seña doblada", async () => {
      const { owner, renter, bookingId } = await acceptedBooking();
      const { checkout: pago } = await payBookingFully(
        app,
        bookingId,
        renter.token,
      );

      const res = await http()
        .patch(`/bookings/${bookingId}/cancel`)
        .set("Authorization", auth(owner.token))
        .send({ reason: "el auto se rompió" })
        .expect(200);
      expect(res.body.cancellation).toMatchObject({
        rule: "OWNER_RETURNS_SENA_DOUBLED",
        refundToRenterMinor: 330_000,
        ownerPenaltyMinor: 90_000,
      });
      expect(res.body.refund.ok).toBe(true);
      expect(mercadoPago(app).consultar(pago.paymentId)?.status).toBe(
        "refunded",
      );
    });

    /**
     * La cuenta difícil del split: Mercado Pago descuenta la devolución en
     * proporción del dueño y de FreeWheel, y eso no coincide con la política
     * de la seña. Lo que FreeWheel se quedó de más queda anotado como deuda
     * con el dueño.
     */
    it("quien cancela tarde pierde la seña, y el libro corrige el reparto del split", async () => {
      const { owner, renter, bookingId } = await acceptedBooking();
      await payBookingFully(app, bookingId, renter.token);
      // Sobre la fecha (menos de 48 horas) y fuera del plazo de
      // arrepentimiento (pagó hace 11 días).
      const pronto = new Date(Date.now() + 24 * 3_600_000);
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          startDate: pronto,
          endDate: new Date(pronto.getTime() + 3 * 86_400_000),
          paidAt: new Date(Date.now() - 11 * 86_400_000),
        },
      });

      const res = await http()
        .patch(`/bookings/${bookingId}/cancel`)
        .set("Authorization", auth(renter.token))
        .send({ reason: "cambio de planes" })
        .expect(200);
      expect(res.body.cancellation).toMatchObject({
        tier: "tardia",
        rule: "RENTER_FORFEITS_SENA",
        refundToRenterMinor: 240_000,
        ownerReceivesMinor: 81_000,
        platformReceivesMinor: 9_000,
      });

      const admin = await createAdmin(app, prisma);
      const saldo = await saldos(admin.token);
      // FreeWheel termina con su comisión sobre la seña y nada de cobertura.
      expect(saldo("platform:commission")).toBe(9_000);
      expect(saldo("insurance:payable")).toBe(0);
      // Y le debe al dueño lo que el reparto proporcional no le dio.
      expect(saldo(`owner:${owner.id}:payable`)).toBe(7_364);
    });

    it("si la devolución falla, la reserva se cancela igual y se reintenta después", async () => {
      const { renter, bookingId } = await acceptedBooking();
      const { checkout: pago } = await payBookingFully(
        app,
        bookingId,
        renter.token,
      );

      mercadoPago(app).simularFallaEnDevoluciones(true);
      const res = await http()
        .patch(`/bookings/${bookingId}/cancel`)
        .set("Authorization", auth(renter.token))
        .send({ reason: "no voy a viajar" })
        .expect(200);
      expect(res.body.status).toBe("CANCELLED_BY_RENTER");
      expect(res.body.refund.ok).toBe(false);

      // El dueño vuelve a tener saldo; el trabajo diario lo reintenta.
      mercadoPago(app).simularFallaEnDevoluciones(false);
      await prisma.booking.update({
        where: { id: bookingId },
        data: { cancelledAt: new Date(Date.now() - 2 * 3_600_000) },
      });
      const reintentadas = await app
        .get(PaymentsService)
        .retryFailedCancellations(new Date());
      expect(reintentadas).toBe(1);
      expect(mercadoPago(app).consultar(pago.paymentId)?.status).toBe(
        "refunded",
      );
    });
  });

  // ── Lo que ve cada uno ────────────────────────────────────────────────────

  describe("lo que ve cada uno", () => {
    it("el estado no devuelve la huella de la tarjeta ni la IP de quien pagó", async () => {
      const { owner, renter, bookingId } = await acceptedBooking();
      await payBookingFully(app, bookingId, renter.token);

      const status = await http()
        .get(`/payments/bookings/${bookingId}/status`)
        .set("Authorization", auth(owner.token))
        .expect(200);
      const crudo = JSON.stringify(status.body);
      expect(crudo).not.toContain("mpfp_");
      expect(crudo).not.toContain("initiatedIp");
      expect(status.body.records[0].cardLast4).toBe("3704");

      const fila = await prisma.paymentRecord.findFirstOrThrow({
        where: { bookingId, kind: "CHECKOUT" },
      });
      expect(fila.initiatedIp).toEqual(expect.any(String));
    });

    it("la reserva no expone los identificadores de los cobros", async () => {
      const { renter, bookingId } = await acceptedBooking();
      await payBookingFully(app, bookingId, renter.token);
      const booking = await http()
        .get(`/bookings/${bookingId}`)
        .set("Authorization", auth(renter.token))
        .expect(200);
      expect(booking.body).not.toHaveProperty("checkoutPaymentId");
      expect(booking.body).not.toHaveProperty("depositPaymentId");
      expect(booking.body).not.toHaveProperty("savedPaymentMethodId");
    });

    it("quien no es parte de la reserva no ve sus pagos", async () => {
      const { bookingId } = await acceptedBooking();
      const extrano = await registerUser(app);
      await http()
        .get(`/payments/bookings/${bookingId}/status`)
        .set("Authorization", auth(extrano.token))
        .expect(403);
    });

    it("las tarjetas guardadas no existen con el split, y se dice", async () => {
      const usuario = await registerUser(app);
      const res = await http()
        .get("/payments/methods")
        .set("Authorization", auth(usuario.token))
        .expect(200);
      expect(res.body).toMatchObject({ cards: [], supported: false });
    });
  });
});
