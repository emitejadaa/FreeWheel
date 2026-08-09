import { BookingStatus, PhotoVisibility } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { aplicarVisibilidadDeFotos } from "./photo-visibility.interceptor";

/**
 * Estas pruebas son sobre el ajuste "quién ve mi foto". Lo que se comprueba es
 * justo lo que hace que el ajuste sirva o no sirva:
 *  · con EVERYONE la foto pasa (y no se consulta la base al vicio);
 *  · con BOOKED la foto NO pasa a un desconocido;
 *  · con BOOKED la foto SÍ pasa a quien tiene una reserva en común;
 *  · la propia foto se ve siempre;
 *  · el ajuste ajeno no viaja en la respuesta;
 *  · y el recorrido encuentra a la persona esté donde esté en la respuesta,
 *    porque de eso depende que no se filtre por una ruta que nadie revisó.
 */

type Consulta = {
  where: {
    status: { notIn: BookingStatus[] };
    OR: { ownerId?: string; renterId?: unknown }[];
  };
};

/** Un Prisma de mentira que anota si lo llamaron y con qué. */
function prismaFalso(reservas: { ownerId: string; renterId: string }[] = []): {
  prisma: PrismaService;
  consultas: Consulta[];
} {
  const consultas: Consulta[] = [];
  const prisma = {
    booking: {
      findMany: (args: Consulta) => {
        consultas.push(args);
        return Promise.resolve(reservas);
      },
    },
  } as unknown as PrismaService;
  return { prisma, consultas };
}

const persona = (
  id: string,
  visibility: PhotoVisibility,
  url: string | null = "https://cdn/foto.jpg",
) => ({
  id,
  firstName: "Ignacio",
  profilePhotoUrl: url,
  profilePhotoVisibility: visibility,
});

describe("aplicarVisibilidadDeFotos", () => {
  it("deja pasar la foto de quien la puso para todo el mundo, sin consultar la base", async () => {
    const { prisma, consultas } = prismaFalso();
    const cuerpo = { owner: persona("otro", PhotoVisibility.EVERYONE) };

    await aplicarVisibilidadDeFotos(prisma, "yo", cuerpo);

    expect(cuerpo.owner.profilePhotoUrl).toBe("https://cdn/foto.jpg");
    expect(consultas).toHaveLength(0);
  });

  it("tapa la foto restringida cuando no hay ninguna reserva en común", async () => {
    const { prisma, consultas } = prismaFalso([]);
    const cuerpo = { owner: persona("otro", PhotoVisibility.BOOKED) };

    await aplicarVisibilidadDeFotos(prisma, "yo", cuerpo);

    expect(cuerpo.owner.profilePhotoUrl).toBeNull();
    expect(consultas).toHaveLength(1);
    // Un pedido rechazado o cancelado no cuenta como haber reservado.
    expect(consultas[0].where.status.notIn).toEqual([
      BookingStatus.REJECTED,
      BookingStatus.CANCELLED_BY_RENTER,
      BookingStatus.CANCELLED_BY_OWNER,
    ]);
  });

  it("muestra la foto restringida a quien tiene una reserva en común", async () => {
    const { prisma } = prismaFalso([{ ownerId: "otro", renterId: "yo" }]);
    const cuerpo = { owner: persona("otro", PhotoVisibility.BOOKED) };

    await aplicarVisibilidadDeFotos(prisma, "yo", cuerpo);

    expect(cuerpo.owner.profilePhotoUrl).toBe("https://cdn/foto.jpg");
  });

  it("la reserva vale en los dos sentidos: como dueño y como inquilino", async () => {
    const { prisma } = prismaFalso([{ ownerId: "yo", renterId: "otro" }]);
    const cuerpo = { renter: persona("otro", PhotoVisibility.BOOKED) };

    await aplicarVisibilidadDeFotos(prisma, "yo", cuerpo);

    expect(cuerpo.renter.profilePhotoUrl).toBe("https://cdn/foto.jpg");
  });

  it("la foto propia se ve siempre, aunque esté restringida", async () => {
    const { prisma, consultas } = prismaFalso([]);
    const cuerpo = persona("yo", PhotoVisibility.BOOKED);

    await aplicarVisibilidadDeFotos(prisma, "yo", cuerpo);

    expect(cuerpo.profilePhotoUrl).toBe("https://cdn/foto.jpg");
    // Y el ajuste propio SÍ viaja: el perfil necesita saber cómo está puesto.
    expect(cuerpo.profilePhotoVisibility).toBe(PhotoVisibility.BOOKED);
    expect(consultas).toHaveLength(0);
  });

  it("no devuelve el ajuste de otra persona", async () => {
    const { prisma } = prismaFalso();
    const cuerpo = { owner: persona("otro", PhotoVisibility.EVERYONE) };

    await aplicarVisibilidadDeFotos(prisma, "yo", cuerpo);

    expect("profilePhotoVisibility" in cuerpo.owner).toBe(false);
  });

  it("encuentra a la persona esté donde esté: en un array, anidada, o repetida", async () => {
    const { prisma, consultas } = prismaFalso([]);
    const repetida = persona("otro", PhotoVisibility.BOOKED);
    const cuerpo = {
      data: [
        { listing: { owner: repetida } },
        { review: { author: persona("tercero", PhotoVisibility.BOOKED) } },
      ],
      // El mismo objeto otra vez: no tiene que romper ni quedar sin tapar.
      destacado: { owner: repetida },
    };

    await aplicarVisibilidadDeFotos(prisma, "yo", cuerpo);

    expect(repetida.profilePhotoUrl).toBeNull();
    expect(
      (cuerpo.data[1] as { review: { author: { profilePhotoUrl: unknown } } })
        .review.author.profilePhotoUrl,
    ).toBeNull();
    // Las dos personas restringidas se preguntan en UNA sola consulta.
    expect(consultas).toHaveLength(1);
  });

  it("sin sesión, ninguna foto restringida se muestra y no se consulta la base", async () => {
    const { prisma, consultas } = prismaFalso();
    const cuerpo = { owner: persona("otro", PhotoVisibility.BOOKED) };

    await aplicarVisibilidadDeFotos(prisma, null, cuerpo);

    expect(cuerpo.owner.profilePhotoUrl).toBeNull();
    expect(consultas).toHaveLength(0);
  });

  it("no toca una respuesta que no tiene personas adentro", async () => {
    const { prisma, consultas } = prismaFalso();
    const cuerpo = { ok: true, data: [{ id: "listing-1", title: "Gol 2019" }] };

    const salida = await aplicarVisibilidadDeFotos(prisma, "yo", cuerpo);

    expect(salida).toEqual({
      ok: true,
      data: [{ id: "listing-1", title: "Gol 2019" }],
    });
    expect(consultas).toHaveLength(0);
  });

  it("no se cae con fechas, null ni valores que no son objetos", async () => {
    const { prisma } = prismaFalso();
    const cuerpo = {
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      nada: null,
      numero: 7,
      owner: persona("otro", PhotoVisibility.EVERYONE),
    };

    await expect(
      aplicarVisibilidadDeFotos(prisma, "yo", cuerpo),
    ).resolves.toBeDefined();
    expect(cuerpo.createdAt instanceof Date).toBe(true);
  });
});
