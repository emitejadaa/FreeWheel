import { ConversationsService } from "./conversations.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";

/**
 * EL AVISO DE "TENÉS MENSAJES SIN LEER"
 *
 * Lo que se prueba acá son las dos cosas que hacen que este aviso sirva en vez
 * de molestar:
 *
 *  1) UNA SOLA VEZ POR CHARLA. Escribir "hola", "¿estás?" y "te paso la
 *     dirección" son tres mensajes en un minuto. Si cada uno mandara un mail, el
 *     tercero ya estaría en la carpeta de spam junto con los otros dos, y la
 *     próxima reserva de verdad tampoco se vería. La marca se borra cuando la
 *     persona abre la conversación, así el mensaje siguiente vuelve a avisar.
 *
 *  2) EL MAIL NO LLEVA EL MENSAJE. Dos personas arreglando la entrega de un auto
 *     se pasan direcciones, horarios y teléfonos. Eso no tiene por qué viajar
 *     por mail ni quedar guardado en una bandeja de entrada que puede abrir
 *     cualquiera que tenga ese teléfono en la mano. Acá se comprueba que lo
 *     único que sale del servicio es a quién avisarle y de qué publicación es.
 *
 * Y una tercera, menos vistosa pero igual de importante: que un problema
 * mandando el mail NO haga fallar el envío del mensaje. El mensaje ya se guardó;
 * hacer explotar la pantalla de quien escribió por un mail que no salió sería
 * cambiar un problema chico por uno grande.
 */
describe("ConversationsService — aviso de mensajes sin leer", () => {
  const CONVERSACION = {
    id: "c-1",
    ownerId: "duenio",
    renterId: "inquilino",
    listing: { title: "Toyota Corolla 2021" },
  };

  let personas: Record<
    string,
    { email: string; firstName: string; lastUnreadEmailAt: Date | null }
  >;
  let avisos: {
    to: string;
    params: { recipientName?: string; listingLabel?: string };
  }[];
  let service: ConversationsService;
  let fallaElMail: boolean;

  beforeEach(() => {
    fallaElMail = false;
    avisos = [];
    personas = {
      duenio: {
        email: "duenio@test.com",
        firstName: "Sergio",
        lastUnreadEmailAt: null,
      },
      inquilino: {
        email: "inquilino@test.com",
        firstName: "Beto",
        lastUnreadEmailAt: null,
      },
    };

    const prisma = {
      conversation: {
        findUnique: () => Promise.resolve(CONVERSACION),
        update: () => Promise.resolve(CONVERSACION),
      },
      message: {
        create: ({ data }: { data: unknown }) =>
          Promise.resolve({ id: "m-1", ...(data as object) }),
        updateMany: () => Promise.resolve({ count: 1 }),
      },
      user: {
        findUnique: ({ where }: { where: { id: string } }) =>
          Promise.resolve(personas[where.id] ?? null),
        update: ({
          where,
          data,
        }: {
          where: { id: string };
          data: { lastUnreadEmailAt: Date | null };
        }) => {
          personas[where.id].lastUnreadEmailAt = data.lastUnreadEmailAt;
          return Promise.resolve(personas[where.id]);
        },
      },
    } as unknown as PrismaService;

    const email = {
      sendUnreadMessages: (
        to: string,
        params: { recipientName?: string; listingLabel?: string },
      ) => {
        if (fallaElMail) return Promise.reject(new Error("gmail caído"));
        avisos.push({ to, params });
        return Promise.resolve();
      },
    } as unknown as EmailService;

    service = new ConversationsService(prisma, email);
  });

  /** El aviso sale sin esperarlo (void): hay que dejar correr la microcola. */
  const esperarAlAviso = () => new Promise((r) => setTimeout(r, 0));

  it("le avisa a la OTRA persona, no a quien escribió", async () => {
    await service.sendMessage("duenio", "c-1", "Hola");
    await esperarAlAviso();

    expect(avisos).toHaveLength(1);
    expect(avisos[0].to).toBe("inquilino@test.com");
    expect(avisos[0].params.recipientName).toBe("Beto");
  });

  it("el aviso NO lleva el texto del mensaje", async () => {
    await service.sendMessage(
      "duenio",
      "c-1",
      "Te espero en Av. Corrientes 1234, 11-3289-5416",
    );
    await esperarAlAviso();

    const todo = JSON.stringify(avisos);
    expect(todo).not.toContain("Corrientes");
    expect(todo).not.toContain("3289");
    // De qué charla es, sí.
    expect(avisos[0].params.listingLabel).toBe("Toyota Corolla 2021");
  });

  it("tres mensajes seguidos mandan UN solo mail", async () => {
    await service.sendMessage("duenio", "c-1", "Hola");
    await esperarAlAviso();
    await service.sendMessage("duenio", "c-1", "¿Estás?");
    await esperarAlAviso();
    await service.sendMessage("duenio", "c-1", "Te paso la dirección");
    await esperarAlAviso();

    expect(avisos).toHaveLength(1);
  });

  it("después de abrir la conversación, el mensaje siguiente vuelve a avisar", async () => {
    await service.sendMessage("duenio", "c-1", "Hola");
    await esperarAlAviso();
    expect(avisos).toHaveLength(1);

    // El inquilino abre el chat.
    await service.markAsRead("inquilino", "c-1");
    expect(personas.inquilino.lastUnreadEmailAt).toBeNull();

    await service.sendMessage("duenio", "c-1", "Una cosa más");
    await esperarAlAviso();
    expect(avisos).toHaveLength(2);
  });

  it("si el mail falla, el mensaje se manda igual", async () => {
    fallaElMail = true;

    const mensaje = await service.sendMessage("duenio", "c-1", "Hola");

    await expect(esperarAlAviso()).resolves.toBeUndefined();
    expect(mensaje).toMatchObject({ id: "m-1", content: "Hola" });
    expect(avisos).toHaveLength(0);
  });
});
