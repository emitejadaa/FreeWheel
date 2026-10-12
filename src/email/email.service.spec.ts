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
  let enviados: {
    to: string;
    subject: string;
    html: string;
    attachments?: { cid: string; filename: string; content: Buffer }[];
  }[];
  let service: EmailService;
  // Con qué preferencia contesta la base para cada dirección. Por defecto no hay
  // ninguna cuenta cargada, y eso ya es un caso real: el mail de cambio de email
  // va a una dirección que todavía no es de nadie.
  let cuentas: Record<string, { emailNotifications: boolean }>;

  beforeEach(() => {
    enviados = [];
    cuentas = {};
    (nodemailer.createTransport as jest.Mock).mockReturnValue({
      sendMail: (mail: {
        to: string;
        subject: string;
        html: string;
        attachments?: { cid: string; filename: string; content: Buffer }[];
      }) => {
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
        tier: "libre" as const,
      });
      expect(ultimo().html).toContain("Se devuelve todo lo pagado");

      await service.sendBookingCancelled("a@b.com", {
        ...base,
        refunded: false,
      });
      expect(ultimo().html).toContain("No hay cobros pendientes");
    });

    it("CUANDO SE RETIENE LA SEÑA, EL MAIL DICE CUÁNTO Y POR QUÉ", async () => {
      /*
        Una política de cancelación que no se cuenta en el momento en que se
        aplica no es clara: quien cancela la noche anterior tiene que leer acá
        por qué no le vuelve la seña, y no descubrirlo tres días después
        mirando el resumen de la tarjeta.
      */
      await service.sendBookingCancelled("a@b.com", {
        otherPartyName: "Beto",
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
        cancelaste: true,
        refunded: true,
        tier: "tardia" as const,
        senaRetenida: 87780,
        currency: "USD",
      });

      const { html } = ultimo();
      expect(html).toContain("se retiene la seña");
      expect(html).toContain("87.780");
      expect(html).toContain("48 horas");
      // Y que el depósito se libera igual, que es la duda inmediata.
      expect(html).toContain("depósito en garantía se libera");
    });

    it("si canceló el dueño, vuelve todo y el mail lo dice", async () => {
      // El que incumple no se queda además con la plata de la otra persona.
      await service.sendBookingCancelled("a@b.com", {
        otherPartyName: "Beto",
        vehicleLabel: "Toyota Corolla 2021",
        startDate: DESDE,
        endDate: HASTA,
        cancelaste: false,
        refunded: true,
        tier: "delDueno" as const,
      });

      const { html } = ultimo();
      expect(html).toContain("Se devuelve todo lo pagado");
      expect(html).toContain("la hizo el dueño");
    });
  });

  describe("lo que escribe una persona no se vuelve HTML", () => {
    const LINK = '<a href="https://evil.example">Verificá tu pago</a>';

    it("un nombre con un link llega como texto a la otra parte", async () => {
      await service.sendBookingCancelled("duenio@test.com", {
        recipientName: "Ana",
        otherPartyName: LINK,
        vehicleLabel: '<img src="x">Corolla',
        startDate: DESDE,
        endDate: HASTA,
        reason: "<script>alert(1)</script>",
        cancelaste: false,
      });

      const { html } = ultimo();
      expect(html).not.toContain('<a href="https://evil.example"');
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    });

    it("tampoco en el comprobante de la reserva (dirección, nombres, auto)", async () => {
      await service.sendBookingReceipt("inquilino@test.com", {
        renterName: LINK,
        ownerName: LINK,
        bookingId: "reserva-1",
        vehicleLabel: '<img src="x">Corolla',
        locationText: LINK,
        startDate: DESDE,
        endDate: HASTA,
        days: 4,
        currency: "usd",
        total: 100,
      });
      const { html } = ultimo();
      expect(html).not.toContain('<a href="https://evil.example"');
      expect(html).not.toContain('<img src="x">');
    });

    it("tampoco en los mails con datos sueltos (precio, contraseña)", async () => {
      await service.sendPriceChangeCode("a@test.com", LINK, 100, 120, "123456");
      expect(ultimo().html).not.toContain('<a href="https://evil.example"');

      await service.sendPasswordReset("a@test.com", LINK, "token", "uid");
      expect(ultimo().html).not.toContain('<a href="https://evil.example"');
    });
  });

  describe("el depósito en garantía", () => {
    it("EXPLICA QUE NUNCA SE COBRÓ, que es lo que nadie entiende", async () => {
      /*
        El depósito es la única plata del alquiler que se ve salir y no se ve
        volver: liberar una retención no genera ningún movimiento en el resumen
        de la tarjeta. Sin decir esto, la gente espera un reembolso que no va a
        llegar nunca, porque no hay nada que reembolsar.
      */
      await service.sendDepositReleased("a@b.com", {
        renterName: "Ana",
        amount: 200,
        currency: "USD",
        vehicleLabel: "Toyota Corolla 2021",
        cardBrand: "visa",
        cardLast4: "4242",
      });

      const { subject, html } = ultimo();
      expect(subject).toContain("depósito");
      expect(html).toContain("nunca se te cobró");
      expect(html).toContain("200");
      // La marca del procesador viene en minúscula y en un mail se lee como un
      // error de tipeo.
      expect(html).toContain("Visa ···· 4242");
      expect(html).toContain("días hábiles");
    });

    it("sin tarjeta guardada no inventa una fila", async () => {
      await service.sendDepositReleased("a@b.com", {
        amount: 200,
        currency: "USD",
        vehicleLabel: "Toyota Corolla 2021",
      });
      expect(ultimo().html).not.toContain("Tarjeta");
    });

    it("EL COBRO POR DAÑO DICE CUÁNTO, POR QUÉ Y CÓMO RECLAMAR", async () => {
      /*
        Es el peor mail de la aplicación: le avisa a alguien que le cobraron
        plata que esperaba que le volviera. Un depósito de 200 con un daño de
        60 no es "te cobramos el depósito": son 60 cobrados y 140 que vuelven, y
        decirlo entero es la diferencia entre una explicación y un susto.
      */
      await service.sendDepositCaptured("a@b.com", {
        recipientName: "Ana",
        esDueño: false,
        otherPartyName: "Beto",
        capturado: 60,
        liberado: 140,
        currency: "USD",
        vehicleLabel: "Toyota Corolla 2021",
        motivo:
          "Rayón profundo en la puerta trasera izquierda, con foto del retiro y de la devolución.",
      });

      const { html } = ultimo();
      expect(html).toContain("60");
      expect(html).toContain("140");
      // El motivo entero, sin recortar: es lo que la persona va a leer para
      // decidir si está de acuerdo, y "daño" no es una respuesta.
      expect(html).toContain("Rayón profundo en la puerta trasera izquierda");
      expect(html).toContain("Si no estás de acuerdo");
    });

    it("al dueño le llega la otra mitad", async () => {
      await service.sendDepositCaptured("d@b.com", {
        esDueño: true,
        otherPartyName: "Ana",
        capturado: 60,
        liberado: 140,
        currency: "USD",
        vehicleLabel: "Toyota Corolla 2021",
        motivo: "Rayón profundo en la puerta trasera izquierda.",
      });

      const { subject, html } = ultimo();
      expect(subject).toContain("Se cobró el depósito por el daño");
      // Al dueño no se le ofrece reclamar contra sí mismo.
      expect(html).not.toContain("Si no estás de acuerdo");
      expect(html).toContain("se transfiere junto con el resto");
    });

    it("al dueño se le dice que su reclamo no prospero, y por que", async () => {
      /*
        Sin este mail, rechazar era una decision que solo veia quien la tomaba:
        el dueño mandaba fotos, esperaba, y del otro lado no pasaba nada
        visible. La liberacion del deposito le llega al INQUILINO, no a el.
      */
      await service.sendDamageClaimRejected("d@b.com", {
        ownerName: "Ana",
        vehicleLabel: "Toyota Corolla 2021",
        reclamado: 60,
        currency: "USD",
        nota: "El rayon ya aparece en las fotos del retiro: no lo hizo quien alquilo.",
      });

      const { subject, html } = ultimo();
      expect(subject).toContain("no prosper");
      expect(html).toContain("60");
      expect(html).toContain("El rayon ya aparece en las fotos del retiro");
      // Y que el deposito vuelve entero, que es la consecuencia.
      expect(html).toContain("se libera entero");
    });

    it("si se cobra todo, no promete que vuelve algo", async () => {
      await service.sendDepositCaptured("a@b.com", {
        esDueño: false,
        otherPartyName: "Beto",
        capturado: 200,
        liberado: 0,
        currency: "USD",
        vehicleLabel: "Toyota Corolla 2021",
        motivo: "Paragolpes delantero roto.",
      });
      const { html } = ultimo();
      expect(html).toContain("No queda nada retenido");
      expect(html).not.toContain("Se libera");
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

  /*
    EL COMPROBANTE CON EL QR DEL RETIRO

    Este mail existe para un momento concreto: la persona parada al lado del
    auto, a veces sin señal. Todo lo que se prueba acá sale de ahí.

    Y hay una propiedad que no es de presentación sino de seguridad: el código
    del retiro es lo que confirma la entrega del auto. No puede terminar en una
    dirección web, ni nuestra ni de un generador de QR ajeno, porque una
    dirección es algo que alguien puede abrir.
  */
  describe("el comprobante con el QR del retiro", () => {
    const CODIGO = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4";

    const comprobante = (extra = {}) =>
      service.sendBookingReceipt("inquilino@test.com", {
        renterName: "Ignacio",
        bookingId: "abcdef12-0000-0000-0000-000000000000",
        vehicleLabel: "Volkswagen Taos 2022",
        ownerName: "Emiliano",
        locationText: "Villa Crespo, CABA",
        startDate: DESDE,
        endDate: HASTA,
        days: 4,
        currency: "ARS",
        rentalSubtotal: 160000,
        insurance: 12000,
        platformFee: 17200,
        total: 189200,
        deposit: 80000,
        pickupToken: CODIGO,
        ...extra,
      });

    it("EL CÓDIGO VA ESCRITO, no solo adentro de la imagen", async () => {
      // Los clientes de correo no muestran las imágenes hasta que uno lo pide.
      // Si el código estuviera solo en el QR, el mail llegaría vacío justo en
      // lo único que importa, y el dueño no tendría qué escribir a mano.
      await comprobante();
      expect(ultimo().html).toContain(CODIGO);
    });

    it("el QR viaja ADENTRO del mail, no enlazado", async () => {
      await comprobante();
      const adjuntos = ultimo().attachments ?? [];
      expect(adjuntos).toHaveLength(1);
      expect(adjuntos[0].cid).toBe("qr-retiro");
      expect(adjuntos[0].content.length).toBeGreaterThan(100);
      // Un PNG empieza con estos cuatro bytes.
      expect(adjuntos[0].content.subarray(1, 4).toString()).toBe("PNG");
      expect(ultimo().html).toContain('src="cid:qr-retiro"');
    });

    it("EL CÓDIGO DEL RETIRO NO APARECE EN NINGUNA DIRECCIÓN WEB", async () => {
      /*
        La prueba que cuida lo importante. Si el QR se generara pidiéndoselo a
        un servicio de afuera, o si la imagen se sirviera desde una URL nuestra,
        el código quedaría en una dirección: algo que viaja por el camino, queda
        en registros y cualquiera que la tenga puede abrir.
      */
      await comprobante();
      const direcciones =
        ultimo().html.match(/(?:https?:)?\/\/[^"'\s)]+/g) ?? [];
      for (const url of direcciones) {
        expect(url).not.toContain(CODIGO);
      }
      // Y ningún generador de QR de afuera.
      expect(ultimo().html).not.toMatch(
        /qrserver|chart\.googleapis|quickchart/i,
      );
    });

    it("lleva la cuenta entera, no solo el total", async () => {
      await comprobante();
      const html = ultimo().html;
      expect(html).toContain("Alquiler (4 días)");
      expect(html).toContain("Seguro");
      expect(html).toContain("Total pagado");
      // El auto, las fechas, dónde y quién lo entrega.
      expect(html).toContain("Volkswagen Taos 2022");
      expect(html).toContain("Villa Crespo, CABA");
      expect(html).toContain("Emiliano");
      expect(html).toContain("ABCDEF12");
    });

    it("EL DEPÓSITO SE EXPLICA COMO RETENIDO, NO COMO COBRADO", async () => {
      // Es el número que más confunde: aparece en el resumen de la tarjeta como
      // si fuera un consumo. Verlo explicado en el comprobante es la diferencia
      // entre una duda y un reclamo.
      await comprobante();
      const html = ultimo().html;
      expect(html).toContain("No es un cobro");
      expect(html).toMatch(/retenido/i);
    });

    it("un dia solo se dice en singular", async () => {
      await comprobante({ days: 1 });
      expect(ultimo().html).toContain("Alquiler (1 día)");
    });

    it("sin seguro ni comision no se escriben renglones en cero", async () => {
      await comprobante({ insurance: 0, platformFee: 0, deposit: 0 });
      const html = ultimo().html;
      expect(html).not.toContain("Seguro");
      expect(html).not.toContain("Servicio de Freewheel");
      expect(html).not.toContain("No es un cobro");
      // El total sí, siempre.
      expect(html).toContain("Total pagado");
    });

    it("SIN CÓDIGO EL MAIL SALE IGUAL, con el resto de los datos", async () => {
      // Si el código no se pudiera descifrar, quedarse sin mandar el
      // comprobante sería perder también el detalle de lo que se pagó.
      await comprobante({ pickupToken: null });
      expect(enviados).toHaveLength(1);
      expect(ultimo().attachments).toBeUndefined();
      expect(ultimo().html).toContain("Total pagado");
      expect(ultimo().html).not.toContain("Mostrale este código");
    });

    it("el asunto lleva el numero de reserva, para poder buscarlo despues", async () => {
      await comprobante();
      expect(ultimo().subject).toContain("ABCDEF12");
      expect(ultimo().subject).not.toContain(CODIGO);
    });

    it("es un aviso: quien los apago no lo recibe", async () => {
      cuentas["inquilino@test.com"] = { emailNotifications: false };
      await comprobante();
      expect(enviados).toHaveLength(0);
    });
  });
});
