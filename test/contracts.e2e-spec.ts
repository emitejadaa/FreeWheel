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

describe("Contracts", () => {
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

  async function acceptedBooking(): Promise<{
    owner: AuthedUser;
    renter: AuthedUser;
    bookingId: string;
  }> {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
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
    await http()
      .patch(`/bookings/${created.body.id}/accept`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    return { owner, renter, bookingId: created.body.id };
  }

  /**
   * El contrato lleva el ticket completo: lo que se paga, dividido en
   * conceptos, y a dónde va cada parte. Las dos sumas tienen que dar el mismo
   * total, porque son dos formas de mirar la misma plata —qué se cobra y cómo
   * se reparte—. Si una da distinto de la otra, alguien está cobrando o
   * pagando algo que el contrato no dice.
   *
   * 1000 por día × 3 días = 3000 de alquiler; 10 % de comisión y 10 % de
   * cobertura sobre eso. En unidades mínimas, que es como viaja todo.
   */
  it("creates the contract on accept with the full money breakdown for both parties", async () => {
    const { owner, renter, bookingId } = await acceptedBooking();

    for (const user of [owner, renter]) {
      const res = await http()
        .get(`/contracts/bookings/${bookingId}`)
        .set("Authorization", auth(user.token))
        .expect(200);

      expect(res.body.status).toBe("PENDING_ACCEPTANCE");
      expect(res.body.version).toBe(res.body.terms.version);
      expect(res.body.contentHash).toEqual(expect.any(String));

      const ticket = res.body.terms.ticket;
      expect(ticket.totalMinor).toBe(330_000);
      expect(ticket.sena.amountMinor).toBe(90_000);
      expect(ticket.sena.percentOfRental).toBe(30);
      expect(ticket.deposit.amountMinor).toBe(20_000);
      expect(ticket.deposit.kind).toBe("HOLD");

      const porConcepto = Object.fromEntries(
        (ticket.lines as { code: string; amountMinor: number }[]).map((l) => [
          l.code,
          l.amountMinor,
        ]),
      );
      expect(porConcepto).toEqual({
        SENA: 90_000,
        RENTAL_REST: 210_000,
        INSURANCE: 30_000,
      });

      const porDestino = Object.fromEntries(
        (
          ticket.distribution as { code: string; amountMinor: number }[]
        ).map((l) => [l.code, l.amountMinor]),
      );
      expect(porDestino).toEqual({
        OWNER: 270_000,
        PLATFORM_COMMISSION: 30_000,
        INSURER: 30_000,
      });

      const sumar = (xs: { amountMinor: number }[]) =>
        xs.reduce((t, x) => t + x.amountMinor, 0);
      expect(sumar(ticket.lines)).toBe(ticket.totalMinor);
      expect(sumar(ticket.distribution)).toBe(ticket.totalMinor);
    }
  });

  /**
   * El contrato trae sus cláusulas adentro, no una referencia a un texto que
   * vive en otro lado. Es la diferencia entre poder mostrar QUÉ se aceptó y
   * tener que pedirle a alguien que confíe en que el texto de hoy es el de
   * entonces.
   */
  it("guarda el texto de las cláusulas dentro del contrato", async () => {
    const { renter, bookingId } = await acceptedBooking();
    const res = await http()
      .get(`/contracts/bookings/${bookingId}`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    const clausulas = res.body.terms.clauses as {
      id: string;
      title: string;
      text: string;
    }[];
    expect(clausulas.length).toBeGreaterThan(5);
    for (const c of clausulas) {
      expect(c.text.length).toBeGreaterThan(30);
    }
    const ids = clausulas.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["sena", "danos", "firma"]));

    // Las 48 horas para reportar daños tienen que estar ESCRITAS en el
    // contrato, no solo programadas: es el plazo que después se le opone a
    // alguien que reclama tarde.
    const danos = clausulas.find((c) => c.id === "danos");
    expect(danos?.text).toContain("48 horas");
    expect(res.body.terms.policy.inspectionHours).toBe(48);
  });

  it("serves the contract as a PDF to a participant", async () => {
    const { renter, bookingId } = await acceptedBooking();
    const res = await http()
      .get(`/contracts/bookings/${bookingId}/pdf`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const pdf = res.body as Buffer;
    expect(pdf.length).toBeGreaterThan(500);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  /**
   * El dueño ya firmó al aceptar la reserva: aceptar la reserva ES aceptar el
   * contrato, no hay dos botones. Falta la firma de quien alquila, y con esa
   * el contrato queda ACCEPTED.
   */
  it("marks the contract ACCEPTED only once both parties accept", async () => {
    const { renter, bookingId } = await acceptedBooking();

    const antes = await http()
      .get(`/contracts/bookings/${bookingId}`)
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(antes.body.status).toBe("PENDING_ACCEPTANCE");
    expect(antes.body.ownerAcceptedAt).toEqual(expect.any(String));
    expect(antes.body.renterAcceptedAt).toBeNull();
    expect(antes.body.acceptedByMe).toBe(false);

    const despues = await http()
      .post(`/contracts/bookings/${bookingId}/accept`)
      .set("Authorization", auth(renter.token))
      .expect(201);
    expect(despues.body.status).toBe("ACCEPTED");
    expect(despues.body.renterAcceptedAt).toEqual(expect.any(String));
    expect(despues.body.acceptedByMe).toBe(true);
  });

  /**
   * DE QUÉ SIRVE UNA FIRMA ELECTRÓNICA: de poder mostrar, después, qué texto
   * exacto se aceptó. Por eso cada aceptación guarda el hash del contenido, y
   * ese hash tiene que ser el mismo que el del contrato vigente. Si el texto
   * cambiara después de firmado, los hashes dejarían de coincidir y se vería.
   */
  it("cada aceptación queda atada al texto exacto que se firmó", async () => {
    const { renter, bookingId } = await acceptedBooking();

    await http()
      .post(`/contracts/bookings/${bookingId}/accept`)
      .set("Authorization", auth(renter.token))
      .expect(201);

    const res = await http()
      .get(`/contracts/bookings/${bookingId}`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    const aceptaciones = res.body.acceptances as {
      role: string;
      contentHash: string;
      ip: string | null;
      acceptedAt: string;
    }[];
    expect(aceptaciones).toHaveLength(2);
    expect(aceptaciones.map((a) => a.role).sort()).toEqual([
      "OWNER",
      "RENTER",
    ]);
    for (const a of aceptaciones) {
      expect(a.contentHash).toBe(res.body.contentHash);
      expect(a.acceptedAt).toEqual(expect.any(String));
      // La IP se muestra enmascarada: alcanza para reconocer "fui yo" sin
      // darle a la otra parte la dirección entera de nadie.
      expect(a.ip).toMatch(/x$/);
    }
  });

  /**
   * Firmado el contrato, el texto no se regenera más aunque cambien las
   * cláusulas del sistema: un contrato que se reescribe solo después de
   * firmado no prueba nada.
   */
  it("una vez firmado, el contrato queda congelado", async () => {
    const { renter, bookingId } = await acceptedBooking();

    const primero = await http()
      .get(`/contracts/bookings/${bookingId}`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    await http()
      .post(`/contracts/bookings/${bookingId}/accept`)
      .set("Authorization", auth(renter.token))
      .expect(201);

    const segundo = await http()
      .get(`/contracts/bookings/${bookingId}`)
      .set("Authorization", auth(renter.token))
      .expect(200);

    expect(segundo.body.contentHash).toBe(primero.body.contentHash);
    expect(segundo.body.pdfHash).toBe(primero.body.pdfHash);
    expect(segundo.body.lockedAt).toBe(primero.body.lockedAt);
  });

  it("forbids a non-participant from reading the contract", async () => {
    const { bookingId } = await acceptedBooking();
    const stranger = await registerUser(app);
    await http()
      .get(`/contracts/bookings/${bookingId}`)
      .set("Authorization", auth(stranger.token))
      .expect(403);
  });
});
