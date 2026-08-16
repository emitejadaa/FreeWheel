import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import { EmailService } from "./email.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Lo que se prueba acá es lo que la persona LEE.
 *
 * Un comprobante de pago sin el importe, o una cancelación sin el motivo, es un
 * mail que obliga a entrar a la app para averiguar lo que el mail tenía que
 * decir. Y como el HTML se arma con plantillas compartidas, un cambio en el
 * sobre puede vaciar un dato sin que nada falle: de ahí que se revise el
 * contenido y no solo que "se mandó".
 */
jest.mock("nodemailer");

describe("EmailService", () => {
  let enviados: { to: string; subject: string; html: string }[];
  let service: EmailService;
  // Con qué preferencia contesta la base para cada dirección. Por defecto no hay
  // ninguna cuenta cargada, y eso ya es un caso real: el mail de cambio de email
  // va a una dirección que todavía no es de nadie.
  let cuentas: Record<string, { emailNotifications: boolean }>;

  beforeEach(() => {
    enviados = [];
    cuentas = {};
    (nodemailer.createTransport as jest.Mock).mockReturnValue({
      sendMail: (mail: { to: string; subject: string; html: string }) => {
        enviados.push(mail);
        return Promise.resolve();
      },
    });
    const config = {
      get: (name: string) =>
        ({
          GMAIL_USER: "freewheel@test.com",
          GMAIL_APP_PASSWORD: "clave-de-aplicacion",
          FRONTEND_URL: "https://freewheel-5a.vercel.app",
        })[name],
    } as unknown as ConfigService;
    const prisma = {
      user: {
        findUnique: ({ where }: { where: { email: string } }) =>
          Promise.resolve(cuentas[where.email] ?? null),
      },
    } as unknown as PrismaService;
    service = new EmailService(config, prisma);
  });

  afterEach(() => jest.clearAllMocks());

  const ultimo = () => enviados[enviados.length - 1];
  const DESDE = new Date("2026-09-10T00:00:00.000Z");
  const HASTA = new Date("2026-09-14T00:00:00.000Z");

  describe("ninguno lleva emojis", () => {
    it("el mail de reserva aceptada tampoco", async () => {
      // Tenía un 🎉 en el título. En un mail que habla de plata, un emoji resta
      // seriedad justo donde hace falta que sobre.
      await service.sendBookingAcceptedToRenter("a@b.com", {
        renterName: "Beto",
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
      });

      const emojis = [...ultimo().html].filter(
        (c) => c.codePointAt(0)! > 0x2190,
      );
      expect(emojis).toEqual([]);
    });
  });

  describe("solicitud enviada, al inquilino", () => {
    it("dice el auto, las fechas, el total y que todavía no se cobró nada", async () => {
      await service.sendBookingRequestedToRenter("inquilino@test.com", {
        renterName: "Beto",
        ownerName: "Ana",
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
        totalPrice: 48000,
        currency: "ARS",
      });

      const { to, subject, html } = ultimo();
      expect(to).toBe("inquilino@test.com");
      expect(subject).toContain("Recibimos tu solicitud");
      expect(html).toContain("Toyota Corolla 2021");
      expect(html).toContain("Ana");
      expect(html).toContain("10/09/2026");
      expect(html).toContain("14/09/2026");
      expect(html).toContain("48.000");
      // Lo más importante del mail: que nadie crea que ya le cobraron.
      expect(html).toContain("Todavía no te cobramos nada");
    });
  });

  describe("comprobante de pago", () => {
    it("lleva concepto, importe, auto, fechas y un número de reserva", async () => {
      await service.sendPaymentReceipt("inquilino@test.com", {
        renterName: "Beto",
        concepto: "Seña",
        amount: 14400,
        currency: "ARS",
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
        totalPaid: 14400,
        bookingId: "3f9a1b2c-dead-beef-0000-111122223333",
      });

      const { subject, html } = ultimo();
      expect(subject).toContain("Comprobante de pago");
      expect(subject).toContain("Seña");
      expect(html).toContain("14.400");
      expect(html).toContain("Toyota Corolla 2021");
      // Un identificador corto y en mayúsculas, para poder citarlo en un reclamo.
      expect(html).toContain("3F9A1B2C");
    });

    it("sin el total pagado, no inventa esa fila", async () => {
      await service.sendPaymentReceipt("inquilino@test.com", {
        concepto: "Saldo",
        amount: 33600,
        currency: "ARS",
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
        bookingId: "abcdef12-0000-0000-0000-000000000000",
      });

      expect(ultimo().html).not.toContain("Pagado en total");
    });
  });

  describe("cancelación", () => {
    it("a quien canceló le dice que canceló, no que le cancelaron", async () => {
      await service.sendBookingCancelled("inquilino@test.com", {
        recipientName: "Beto",
        otherPartyName: "Ana",
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
        reason: "Me surgió un viaje",
        cancelaste: true,
      });

      const { subject, html } = ultimo();
      expect(subject).toContain("Cancelaste la reserva");
      expect(html).toContain("registramos la cancelación");
      expect(html).toContain("Ya le avisamos a Ana");
    });

    it("a la otra parte le dice quién canceló y por qué", async () => {
      await service.sendBookingCancelled("dueño@test.com", {
        recipientName: "Ana",
        otherPartyName: "Beto",
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
        reason: "Me surgió un viaje",
        cancelaste: false,
      });

      const { subject, html } = ultimo();
      expect(subject).toContain("La reserva fue cancelada");
      expect(html).toContain("<strong>Beto</strong> canceló");
      // El motivo entero, no un resumen: es lo único que explica qué pasó.
      expect(html).toContain("Me surgió un viaje");
    });

    it("sin motivo escrito no queda una fila vacía", async () => {
      await service.sendBookingCancelled("dueño@test.com", {
        otherPartyName: "Beto",
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
        reason: "   ",
        cancelaste: false,
      });

      expect(ultimo().html).not.toContain("Motivo");
    });

    it("solo promete la devolución si había algo pagado", async () => {
      const base = {
        otherPartyName: "Beto",
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
        cancelaste: false,
      };

      await service.sendBookingCancelled("a@b.com", {
        ...base,
        refunded: true,
      });
      expect(ultimo().html).toContain("se devuelve al mismo medio de pago");

      await service.sendBookingCancelled("a@b.com", {
        ...base,
        refunded: false,
      });
      expect(ultimo().html).toContain("No hay cobros pendientes");
    });
  });

  describe("entrega y devolución", () => {
    it("el texto de la entrega cambia según el rol", async () => {
      const base = {
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
        confirmedAt: DESDE,
      };

      await service.sendPickupConfirmed("dueño@test.com", {
        ...base,
        esDueño: true,
      });
      expect(ultimo().html).toContain("confirmaste la entrega");

      await service.sendPickupConfirmed("inquilino@test.com", {
        ...base,
        esDueño: false,
      });
      expect(ultimo().html).toContain("quedó confirmado el retiro");
    });

    it("la devolución invita a reseñar a la otra persona por su nombre", async () => {
      await service.sendReturnConfirmed("dueño@test.com", {
        recipientName: "Ana",
        otherPartyName: "Beto",
        vehicleLabel: "Toyota Corolla 2021",
        confirmedAt: HASTA,
        esDueño: true,
      });

      const { subject, html } = ultimo();
      expect(subject).toContain("Reserva cerrada");
      expect(html).toContain("dejarle una reseña a Beto");
      expect(html).toContain("Inquilino");
    });
  });

  describe("los links salen al dominio configurado", () => {
    it("no a localhost", async () => {
      await service.sendPaymentReceipt("a@b.com", {
        concepto: "Seña",
        amount: 100,
        currency: "ARS",
        vehicleLabel: "Auto",
        startDate: DESDE,
        endDate: HASTA,
        bookingId: "abcdef12-0000-0000-0000-000000000000",
      });

      expect(ultimo().html).toContain(
        "https://freewheel-5a.vercel.app/my-bookings",
      );
      expect(ultimo().html).not.toContain("localhost");
    });
  });

  /*
    QUIÉN APAGA QUÉ.

    El interruptor de Ajustes apaga los AVISOS. No puede apagar los mails que son
    la única forma de entrar a la cuenta: si alguien apaga los avisos y después
    se olvida la contraseña, el link para recuperarla tiene que llegar igual, o
    esa persona quedó afuera de su propia cuenta sin haber pedido eso.

    Por eso la puerta está en send() y no en sendOrThrow(), y por eso se prueban
    los dos lados: que el aviso NO salga y que el de seguridad SÍ.
  */
  describe("avisos apagados", () => {
    const APAGADA = "no-quiero@avisos.com";

    beforeEach(() => {
      cuentas[APAGADA] = { emailNotifications: false };
    });

    it("un aviso de reserva no sale", async () => {
      await service.sendBookingAcceptedToRenter(APAGADA, {
        renterName: "Beto",
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
      });
      expect(enviados).toHaveLength(0);
    });

    it("el aviso de mensajes sin leer tampoco", async () => {
      await service.sendUnreadMessages(APAGADA, { recipientName: "Beto" });
      expect(enviados).toHaveLength(0);
    });

    it("pero el link para recuperar la contraseña SÍ sale", async () => {
      await service.sendPasswordReset(
        APAGADA,
        "Beto",
        "token-de-prueba",
        "u-1",
      );
      expect(enviados).toHaveLength(1);
      expect(ultimo().to).toBe(APAGADA);
    });

    it("y el código para entrar también", async () => {
      await service.sendVerificationCode(APAGADA, "123456");
      expect(enviados).toHaveLength(1);
    });

    it("con los avisos prendidos, el aviso de reserva sale", async () => {
      cuentas["si@quiero.com"] = { emailNotifications: true };
      await service.sendBookingAcceptedToRenter("si@quiero.com", {
        renterName: "Beto",
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
      });
      expect(enviados).toHaveLength(1);
    });

    it("y a una dirección que no es de ninguna cuenta también", async () => {
      // Pasa de verdad: el código de cambio de email va a la dirección NUEVA,
      // que todavía no pertenece a nadie. Si el silencio fuera el caso por
      // defecto, ese mail no llegaría nunca.
      await service.sendUnreadMessages("nadie@todavia.com", {});
      expect(enviados).toHaveLength(1);
    });
  });

  describe("el aviso de mensajes sin leer", () => {
    it("no copia el mensaje: solo dice que hay algo para leer", async () => {
      await service.sendUnreadMessages("a@b.com", {
        recipientName: "Beto",
        listingLabel: "Toyota Corolla 2021",
      });

      const html = ultimo().html;
      expect(ultimo().subject).toContain("mensajes sin leer");
      // De qué charla es, sí: alcanza para saber si hay que abrirla ahora.
      expect(html).toContain("Toyota Corolla 2021");
      // Y el camino para leerlo, que es en la app.
      expect(html).toContain("/chat");
    });

    it("sin saber de qué publicación es, igual avisa", async () => {
      await service.sendUnreadMessages("a@b.com", { recipientName: "Beto" });
      expect(ultimo().html).toContain("Hola Beto");
      expect(ultimo().html).not.toContain("undefined");
    });
  });

  describe("sin configuración de mail", () => {
    it("un aviso de reserva no se manda y no rompe nada", async () => {
      const sinMail = new EmailService(
        { get: () => undefined } as unknown as ConfigService,
        {
          user: { findUnique: () => Promise.resolve(null) },
        } as unknown as PrismaService,
      );

      await expect(
        sinMail.sendPaymentReceipt("a@b.com", {
          concepto: "Seña",
          amount: 100,
          currency: "ARS",
          vehicleLabel: "Auto",
          startDate: DESDE,
          endDate: HASTA,
          bookingId: "abcdef12-0000-0000-0000-000000000000",
        }),
      ).resolves.toBeUndefined();
      expect(enviados).toHaveLength(0);
    });
  });
});
