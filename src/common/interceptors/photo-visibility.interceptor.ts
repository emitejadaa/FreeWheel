import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { BookingStatus, PhotoVisibility, UserRole } from "@prisma/client";
import { Observable, from, switchMap } from "rxjs";
import { PrismaService } from "../../prisma/prisma.service";
import type { CurrentUserPayload } from "../types/current-user.type";

/**
 * PhotoVisibilityInterceptor — hace valer el ajuste "quién ve mi foto"
 * ---------------------------------------------------------------------------
 * QUÉ PROBLEMA RESUELVE, y por qué es un interceptor y no un `if` en cada lugar.
 *
 * La foto de perfil sale en muchas respuestas distintas: la lista de chats, los
 * mensajes, el dueño de una publicación, el autor de una reseña, las dos partes
 * de una reserva, el perfil público. Poner el control en cada una de esas
 * consultas significa seis lugares donde acordarse, y el séptimo que se agregue
 * mañana se olvida y filtra la foto. Que es justo lo que no puede pasar con un
 * ajuste de privacidad: si falla una sola vez, ya no sirve de nada.
 *
 * Entonces el control va en UN solo lugar, al final de todas las respuestas. El
 * interceptor recorre lo que devolvió el controlador, encuentra a las personas
 * que eligieron BOOKED, y a las que no correspondan les deja `profilePhotoUrl`
 * en null: el front dibuja el círculo con la inicial, exactamente igual que si
 * esa persona no hubiera subido ninguna foto. No hace falta que el front sepa
 * nada de esto.
 *
 * DECISIONES
 *  · Una sola consulta a la base, y SOLO si en la respuesta aparece al menos una
 *    persona con la foto restringida. Con el ajuste por defecto (EVERYONE) el
 *    interceptor no consulta nada: recorre el objeto y sigue de largo.
 *  · El ajuste ajeno no se devuelve. Saber que alguien restringió su foto no le
 *    sirve a nadie más que a esa persona, así que el campo se borra de todos los
 *    que no sean quien hizo el pedido. El front lee el propio en GET /users/me.
 *  · La cuenta de administración no se filtra: el panel necesita ver la foto
 *    para poder revisar una denuncia.
 *  · La propia foto siempre se ve, sin importar el ajuste.
 */

/** Una persona dentro de la respuesta, con lo que hace falta para decidir. */
type Persona = {
  id: string;
  profilePhotoUrl: string | null;
  profilePhotoVisibility?: PhotoVisibility;
};

const esPersona = (nodo: object): nodo is Persona =>
  typeof (nodo as Persona).id === "string" &&
  "profilePhotoVisibility" in nodo &&
  "profilePhotoUrl" in nodo;

/**
 * Estados de reserva que NO cuentan como "reservó con esta persona".
 *
 * Un pedido rechazado o cancelado antes de arrancar es un trato que no pasó, así
 * que no alcanza para ver la foto. Todo el resto sí cuenta, incluido REQUESTED:
 * quien mandó el pedido "reservó", y justo ahí es cuando le sirve ver la cara de
 * la persona con la que va a tratar.
 */
const NO_CUENTAN: BookingStatus[] = [
  BookingStatus.REJECTED,
  BookingStatus.CANCELLED_BY_RENTER,
  BookingStatus.CANCELLED_BY_OWNER,
];

/**
 * Recorre la respuesta y llama a `visitar` con cada objeto que encuentra.
 *
 * El WeakSet es por si el mismo objeto aparece dos veces (pasa: el dueño de una
 * publicación puede ser también el autor de una reseña en la misma respuesta) y
 * para no colgarse si alguna vez hay un ciclo. El tope de profundidad es un
 * seguro más: ninguna respuesta de esta API anida tanto.
 */
function recorrer(
  nodo: unknown,
  visitar: (obj: object) => void,
  vistos: WeakSet<object>,
  profundidad = 0,
): void {
  if (profundidad > 12 || nodo === null || typeof nodo !== "object") return;
  if (nodo instanceof Date || Buffer.isBuffer(nodo)) return;
  if (vistos.has(nodo)) return;
  vistos.add(nodo);

  if (Array.isArray(nodo)) {
    for (const item of nodo) recorrer(item, visitar, vistos, profundidad + 1);
    return;
  }

  visitar(nodo);
  for (const valor of Object.values(nodo)) {
    recorrer(valor, visitar, vistos, profundidad + 1);
  }
}

/** Los ids (de entre `ids`) con los que `viewerId` tiene una reserva en común. */
async function conReservaEnComun(
  prisma: PrismaService,
  viewerId: string,
  ids: string[],
): Promise<Set<string>> {
  const reservas = await prisma.booking.findMany({
    where: {
      status: { notIn: NO_CUENTAN },
      OR: [
        { ownerId: viewerId, renterId: { in: ids } },
        { renterId: viewerId, ownerId: { in: ids } },
      ],
    },
    select: { ownerId: true, renterId: true },
  });

  const permitidos = new Set<string>();
  for (const reserva of reservas) {
    permitidos.add(
      reserva.ownerId === viewerId ? reserva.renterId : reserva.ownerId,
    );
  }
  return permitidos;
}

/**
 * Aplica el ajuste sobre el cuerpo de una respuesta. Exportada aparte del
 * interceptor para poder probarla sin levantar toda la aplicación.
 */
export async function aplicarVisibilidadDeFotos(
  prisma: PrismaService,
  viewerId: string | null,
  cuerpo: unknown,
): Promise<unknown> {
  if (cuerpo === null || typeof cuerpo !== "object") return cuerpo;

  // Primera pasada: ¿hay alguna foto restringida que no sea la propia?
  const restringidas = new Set<string>();
  recorrer(
    cuerpo,
    (obj) => {
      if (!esPersona(obj)) return;
      if (obj.id === viewerId) return;
      if (obj.profilePhotoVisibility !== PhotoVisibility.BOOKED) return;
      if (!obj.profilePhotoUrl) return;
      restringidas.add(obj.id);
    },
    new WeakSet(),
  );

  const permitidas =
    restringidas.size > 0 && viewerId
      ? await conReservaEnComun(prisma, viewerId, [...restringidas])
      : new Set<string>();

  // Segunda pasada: tapar la foto de quien corresponda y sacar el ajuste ajeno.
  recorrer(
    cuerpo,
    (obj) => {
      if (!esPersona(obj)) return;
      if (obj.id === viewerId) return;
      if (restringidas.has(obj.id) && !permitidas.has(obj.id)) {
        obj.profilePhotoUrl = null;
      }
      delete obj.profilePhotoVisibility;
    },
    new WeakSet(),
  );

  return cuerpo;
}

@Injectable()
export class PhotoVisibilityInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const request = context.switchToHttp().getRequest<{
      user?: CurrentUserPayload;
    }>();
    const viewer = request?.user ?? null;

    // El panel de administración tiene que poder ver la foto para revisar una
    // denuncia: si la persona denunciada la tiene restringida, taparla dejaría a
    // quien revisa sin el dato que necesita.
    if (viewer?.role === UserRole.ADMIN) return next.handle();

    return next
      .handle()
      .pipe(
        switchMap((cuerpo: unknown) =>
          from(
            aplicarVisibilidadDeFotos(this.prisma, viewer?.id ?? null, cuerpo),
          ),
        ),
      );
  }
}
